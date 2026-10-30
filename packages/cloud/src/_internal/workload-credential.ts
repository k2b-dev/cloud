import { env } from "../config/env";
import { getProcessApplicationId } from "./process-identity";
import { getProcessNats } from "./process-sync";
import {
  WORKLOAD_CHECK_INTERVAL_MS,
  WORKLOAD_REQUEST_TIMEOUT_MS,
  type WorkloadRequest,
  WorkloadResponseSchema,
  workloadSubject,
} from "./workload-protocol";

export type WorkloadCredentialHealth = { status: "ready"; source: "runtime" | "override" } | { status: "unavailable"; reason: string };
let active: { appId: string; token: string; expiresAt: number } | undefined;
let health: WorkloadCredentialHealth | undefined;
let refreshRuntime: { appId: string; refresh: () => Promise<void> } | undefined;

/** Refresh only this process's app authority; concurrent broker rejections share one request. */
export const refreshAppWorkloadCredential = async (appId: string): Promise<string | undefined> => {
  if (appId !== getProcessApplicationId()) return undefined;
  if (refreshRuntime?.appId === appId) await refreshRuntime.refresh();
  return getAppWorkloadCredential();
};

/** One server-side accessor for workers and app-authority invocation clients. Never send to a target app. */
export const getAppWorkloadCredential = (): string | undefined => {
  const override = env.CLOUD_APP_CREDENTIAL?.trim();
  if (override) return override;
  if (active && active.appId === getProcessApplicationId() && active.expiresAt > Date.now()) return active.token;
  return undefined;
};

export const getAppWorkloadCredentialHealth = (): WorkloadCredentialHealth | undefined => {
  if (env.CLOUD_APP_CREDENTIAL?.trim()) return { status: "ready", source: "override" };
  if (active && active.expiresAt <= Date.now()) return { status: "unavailable", reason: "expired" };
  return health;
};

export const createAppWorkloadCredential = (options: {
  appId: string;
  instanceId: string;
  request?: (request: WorkloadRequest) => Promise<unknown>;
  onUnavailable?: (reason: string) => void;
  onRecovered?: () => void;
}) => {
  let credentialId: string | null = null;
  let running = false;
  let refreshFailed = false;
  let timer: Timer | undefined;
  let inFlight: Promise<void> | undefined;
  const request =
    options.request ??
    (async (input: WorkloadRequest) => {
      const response = await getProcessNats().request(workloadSubject(env.SYNC_NAMESPACE), JSON.stringify(input), {
        timeout: WORKLOAD_REQUEST_TIMEOUT_MS,
      });
      return response.json<unknown>();
    });
  const unavailable = (reason: string, preserve = false) => {
    refreshFailed = true;
    if (preserve && active && active.expiresAt > Date.now()) return;
    if (!preserve) {
      active = undefined;
      credentialId = null;
    }
    const changed = health?.status !== "unavailable" || health.reason !== reason;
    health = { status: "unavailable", reason };
    if (changed) options.onUnavailable?.(reason);
  };
  const recovered = () => {
    health = { status: "ready", source: "runtime" };
    if (refreshFailed) options.onRecovered?.();
    refreshFailed = false;
  };
  const refresh = async (): Promise<void> => {
    if (env.CLOUD_APP_CREDENTIAL?.trim()) {
      active = undefined;
      health = { status: "ready", source: "override" };
      return;
    }
    try {
      const response = WorkloadResponseSchema.parse(
        await request({ operation: "refresh", appId: options.appId, instanceId: options.instanceId, credentialId }),
      );
      if (!running) return;
      if (response.status === "issued") {
        if (
          response.appId !== options.appId ||
          response.instanceId !== options.instanceId ||
          Date.parse(response.expiresAt) <= Date.now()
        ) {
          unavailable("invalid_response");
          return;
        }
        credentialId = response.credentialId;
        active = { appId: options.appId, token: response.token, expiresAt: Date.parse(response.expiresAt) };
        recovered();
      } else if (response.status === "current" && response.credentialId === credentialId && active && active.expiresAt > Date.now()) {
        recovered();
      } else {
        unavailable(response.status === "current" ? "invalid_response" : response.status, response.status === "unavailable");
      }
    } catch {
      if (running) {
        unavailable("issuance_unavailable", true);
      }
    }
  };
  const refreshOnce = (): Promise<void> => {
    if (inFlight) return inFlight;
    const operation = refresh().finally(() => {
      if (inFlight === operation) inFlight = undefined;
    });
    inFlight = operation;
    return operation;
  };
  const schedule = () => {
    if (!running) return;
    timer = setTimeout(
      () => {
        void refreshOnce().finally(schedule);
      },
      refreshFailed || health?.status === "unavailable" ? 5_000 : WORKLOAD_CHECK_INTERVAL_MS,
    );
  };
  return {
    start: async () => {
      if (running) {
        await inFlight;
        return;
      }
      running = true;
      refreshRuntime = { appId: options.appId, refresh: refreshOnce };
      health = { status: "unavailable", reason: "starting" };
      await refreshOnce();
      schedule();
    },
    refresh: refreshOnce,
    stop: async () => {
      running = false;
      if (refreshRuntime?.refresh === refreshOnce) refreshRuntime = undefined;
      clearTimeout(timer);
      await inFlight;
      if (!env.CLOUD_APP_CREDENTIAL?.trim()) {
        await request({ operation: "release", appId: options.appId, instanceId: options.instanceId, credentialId }).catch(() => {
          // Core's registry reconciliation revokes after disappearance even when this reply is lost.
          options.onUnavailable?.("release_unavailable");
        });
      }
      active = undefined;
      health = undefined;
    },
  };
};
