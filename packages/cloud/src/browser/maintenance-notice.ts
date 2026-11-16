import { type ToastHandle, type ToastOptions, toast } from "@k2b/ui";
import {
  type AppUnavailableReason,
  GATEWAY_STATUS_PATH,
  MAINTENANCE_ADMIN_API_PATH,
  type MaintenancePollKind,
  maintenancePollDelay,
} from "../contracts/maintenance-signals";
import { type MaintenanceNoticeMessages, maintenanceNoticeMessages } from "./maintenance-notice-messages";

/**
 * An open page while the whole Cloud is in maintenance or one app restarts. The gateway answers this page's requests
 * with a `503` problem (`maintenance` or `app_unavailable`); from the first one on, the page shows one persistent
 * toast that says why, and polls the gateway status until it is over. Nothing on the page is discarded:
 *
 * - reads (`GET`, `HEAD`) wait quietly and are sent again once it is over, so no raw error appears;
 * - every other request is an action with an effect: it is never held or repeated. It returns the gateway's `503`
 *   with a `message` that names the reason, as apps show it for any failed action; the person presses again later.
 *
 * A page rendered past the maintenance wall with an admin bypass link says that only this person sees the Cloud,
 * blocks nothing, and offers administrators to end the maintenance.
 */

type Condition =
  | { kind: "cloud" }
  | { kind: "app"; appId: string; reason: AppUnavailableReason }
  | { kind: "bypass"; canEnd: boolean };

export type MaintenanceNoticeOptions = {
  locale: () => string;
  /** The name of an app as the person sees it; falls back to its id. */
  appName?: (appId: string) => string | undefined;
  /** The gateway let this page past the maintenance wall with an admin bypass link. */
  bypass?: boolean;
  /** The viewer may end the maintenance (`POST /api/admin/maintenance/off`). */
  canEnd?: boolean;
  /** Delay before the next status check; the gateway page's schedule unless a test replaces it. */
  delay?: (kind: MaintenancePollKind, elapsedMs: number) => number;
};

const BARRIER = "ti-barrier-block";
/** A status check that hangs counts as a failed one; the next check follows the schedule. */
const STATUS_TIMEOUT_MS = 10_000;

type FetchInput = Parameters<typeof window.fetch>[0];
type FetchInit = Parameters<typeof window.fetch>[1];

const isRead = (input: FetchInput, init: FetchInit): boolean => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  return method === "GET" || method === "HEAD";
};

const sameOriginUrl = (input: FetchInput): URL | null => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
};

/** The condition a gateway `503` problem describes, with the problem itself; null for every other answer. */
const readProblem = async (response: Response): Promise<{ condition: Condition; problem: object } | null> => {
  if (response.status !== 503) return null;
  if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/problem+json")) return null;
  const problem: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!problem || typeof problem !== "object" || !("code" in problem)) return null;
  if (problem.code === "maintenance") return { condition: { kind: "cloud" }, problem };
  if (problem.code !== "app_unavailable" || !("appId" in problem) || typeof problem.appId !== "string") return null;
  const reason = "reason" in problem && problem.reason === "updating" ? "updating" : "unavailable";
  return { condition: { kind: "app", appId: problem.appId, reason }, problem };
};

/** `maintenance`: off, on for everyone, or on but passed by this browser's bypass link. `app`: absent when not asked. */
const readStatus = (body: unknown): { maintenance: "off" | "on" | "bypass"; app?: boolean } | null => {
  if (!body || typeof body !== "object" || !("maintenance" in body)) return null;
  const state = body.maintenance;
  const maintenance = !state || typeof state !== "object" ? "off" : "bypass" in state && state.bypass === true ? "bypass" : "on";
  const app =
    "app" in body && body.app && typeof body.app === "object" && "available" in body.app ? body.app.available === true : undefined;
  return app === undefined ? { maintenance } : { maintenance, app };
};

const same = (a: Condition, b: Condition): boolean =>
  a.kind === b.kind && (a.kind !== "app" || (b.kind === "app" && a.appId === b.appId && a.reason === b.reason));

export const installMaintenanceNotice = (options: MaintenanceNoticeOptions): (() => void) => {
  const original = window.fetch;
  const delay = options.delay ?? ((kind, elapsedMs) => maintenancePollDelay(kind, elapsedMs, Math.random()));
  const t = (): MaintenanceNoticeMessages => maintenanceNoticeMessages.resolve([options.locale()]).t;
  const name = (appId: string): string => options.appName?.(appId) || appId;
  let current: Condition | null = null;
  let since = 0;
  let notice: ToastHandle | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let ending = false;
  let active = true;
  /** Reads waiting for the end; they run again only while nothing blocks. */
  const waiters = new Set<() => void>();

  const release = () => {
    for (const resume of [...waiters]) resume();
  };

  const blockedMessage = (condition: Condition): string => {
    const text = t();
    if (condition.kind !== "app") return text.maintenanceBlocked;
    return condition.reason === "updating"
      ? text.appUpdatingBlocked({ name: name(condition.appId) })
      : text.appDownBlocked({ name: name(condition.appId) });
  };

  const view = (condition: Condition): { description: string; options: ToastOptions } => {
    const text = t();
    const still = { duration: 0, action: null, progress: null } satisfies ToastOptions;
    if (condition.kind === "cloud")
      return { description: text.maintenanceKeeps, options: { ...still, variant: "warning", iconClass: BARRIER, title: text.maintenance } };
    if (condition.kind === "bypass")
      return {
        description: text.bypass,
        options: {
          ...still,
          variant: "warning",
          iconClass: BARRIER,
          title: text.maintenance,
          action: condition.canEnd ? { label: text.end, onClick: () => void endMaintenance() } : null,
        },
      };
    const app = name(condition.appId);
    const restarting = { ...still, variant: "default", progress: "indeterminate" } satisfies ToastOptions;
    return condition.reason === "updating"
      ? { description: text.appUpdatingKeeps, options: { ...restarting, title: text.appUpdating({ name: app }) } }
      : { description: text.appDownKeeps({ name: app }), options: { ...restarting, title: text.appDown({ name: app }) } };
  };

  /** Changes the toast in place. A toast the person closed stays closed for this condition; a new one shows again. */
  const present = (description: string, toastOptions: ToastOptions, fresh: boolean) => {
    if (notice?.update(description, toastOptions)) return;
    notice = fresh ? toast(description, toastOptions) : undefined;
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!current || !active) return;
    timer = setTimeout(() => void check(), delay(current.kind === "app" ? "app" : "cloud", Date.now() - since));
  };

  const enter = (condition: Condition) => {
    current = condition;
    since = Date.now();
    const next = view(condition);
    present(next.description, next.options, true);
    if (condition.kind === "bypass") release();
    schedule();
  };

  const finish = (condition: Condition) => {
    current = null;
    clearTimeout(timer);
    const text = t();
    const title =
      condition.kind === "app"
        ? condition.reason === "updating"
          ? text.appUpdated
          : text.appBack({ name: name(condition.appId) })
        : text.maintenanceEnded;
    const description = condition.kind === "bypass" ? text.bypassEnded : text.continue;
    // Omitted duration: the success toast closes after its reading time.
    const ended: ToastOptions = { variant: "success", title, duration: undefined, progress: null, action: null };
    if (!notice?.update(description, ended)) toast.success(description, { title });
    notice = undefined;
    release();
  };

  /** A request met a `503` problem. Whole-Cloud maintenance covers every app; one app is shown at a time. */
  const begin = (condition: Condition) => {
    if (current && (same(current, condition) || (current.kind === "cloud" && condition.kind === "app"))) return;
    if (current?.kind === "app" && condition.kind === "app") return;
    enter(condition);
  };

  const check = async () => {
    clearTimeout(timer);
    const watched = current;
    if (!watched || checking || !active) return;
    checking = true;
    let status: ReturnType<typeof readStatus> = null;
    const controller = new AbortController();
    const hang = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const url = watched.kind === "app" ? `${GATEWAY_STATUS_PATH}?app=${encodeURIComponent(watched.appId)}` : GATEWAY_STATUS_PATH;
      const response = await original.call(window, url, { cache: "no-store", signal: controller.signal });
      if (response.ok) status = readStatus(await response.json());
    } catch {
      // No answer, such as while the gateway itself restarts: keep the notice and ask again on schedule.
    } finally {
      clearTimeout(hang);
      checking = false;
    }
    if (!active || current !== watched || !status) return schedule();
    const bypass: Condition = { kind: "bypass", canEnd: options.canEnd === true };
    if (status.maintenance === "on") return watched.kind === "cloud" ? schedule() : enter({ kind: "cloud" });
    // An app restarting under a bypassed maintenance ends with the app; the bypass notice then comes back.
    if (watched.kind === "app") {
      if (status.app !== true) return schedule();
      finish(watched);
      if (status.maintenance === "bypass") enter(bypass);
      return;
    }
    if (status.maintenance === "bypass") return watched.kind === "bypass" ? schedule() : enter(bypass);
    finish(watched);
  };

  const endMaintenance = async () => {
    if (ending || current?.kind !== "bypass") return;
    ending = true;
    const text = t();
    present(text.ending, { title: text.maintenance, progress: "indeterminate", action: null }, false);
    let ended = false;
    try {
      const response = await original.call(window, `${MAINTENANCE_ADMIN_API_PATH}/off`, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      ended = response.ok;
    } catch {
      ended = false;
    } finally {
      ending = false;
    }
    if (current?.kind !== "bypass") return;
    if (ended) return finish(current);
    const again = view(current);
    present(text.endFailed, again.options, true);
  };

  /** Resolves once nothing blocks any more; rejects with the request's own abort reason. */
  const waitForEnd = (signal: AbortSignal | null | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const resume = () => {
        waiters.delete(resume);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        waiters.delete(resume);
        reject(signal?.reason);
      };
      waiters.add(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });

  const wrapped: typeof window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>): Promise<Response> => {
    const [input, init] = args;
    const url = sameOriginUrl(input);
    if (!url || url.pathname === GATEWAY_STATUS_PATH) return original.apply(window, args);
    const read = isRead(input, init);
    // Each round waits for a status check that says it is over, so a read repeats at most at the poll schedule.
    for (;;) {
      const response = await original.apply(window, args);
      const found = active ? await readProblem(response) : null;
      if (!found) return response;
      begin(found.condition);
      if (!read) {
        const headers = new Headers(response.headers);
        headers.delete("Content-Length");
        headers.delete("Content-Encoding");
        void response.body?.cancel().catch(() => undefined);
        return new Response(JSON.stringify({ ...found.problem, message: blockedMessage(found.condition) }), {
          status: 503,
          statusText: response.statusText,
          headers,
        });
      }
      void response.body?.cancel().catch(() => undefined);
      await waitForEnd(init?.signal ?? (input instanceof Request ? input.signal : undefined));
    }
  }, original);
  window.fetch = wrapped;

  const now = () => {
    if (document.visibilityState === "visible") void check();
  };
  document.addEventListener("visibilitychange", now);
  window.addEventListener("online", now);
  if (options.bypass) enter({ kind: "bypass", canEnd: options.canEnd === true });

  return () => {
    active = false;
    current = null;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", now);
    window.removeEventListener("online", now);
    if (window.fetch === wrapped) window.fetch = original;
    notice?.dismiss();
    release();
  };
};
