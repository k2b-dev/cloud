import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { env } from "../config/env";
import { bindProcessApplicationId, clearProcessApplicationId } from "./process-identity";
import { appReadinessResponse } from "./readiness";
import { createAppWorkloadCredential, getAppWorkloadCredential, getAppWorkloadCredentialHealth } from "./workload-credential";
import type { WorkloadRequest } from "./workload-protocol";

const now = new Date("2026-10-29T12:00:00Z");
const instanceId = "0123456789abcdef";
const credentialId = "12345678-1234-4234-8234-123456789abc";
const token = `cld_${"a".repeat(24)}_${"b".repeat(64)}`;
const issued = { status: "issued", appId: "inventory", instanceId, credentialId, token, expiresAt: "2026-10-29T13:00:00Z" };
const originalOverride = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_CREDENTIAL")!;
let runtime: ReturnType<typeof createAppWorkloadCredential> | undefined;
beforeEach(() => {
  setSystemTime(now);
  Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", { value: undefined, configurable: true });
  bindProcessApplicationId("inventory");
});
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", originalOverride);
  clearProcessApplicationId();
  setSystemTime();
});

describe("automatic application workload credential", () => {
  test("obtains at start, checks, replaces rotated tokens, and releases on stop", async () => {
    const requests: WorkloadRequest[] = [];
    let reply: unknown = issued;
    runtime = createAppWorkloadCredential({
      appId: "inventory",
      instanceId,
      request: async (request) => {
        requests.push(request);
        return reply;
      },
    });
    await runtime.start();
    expect(getAppWorkloadCredential()).toBe(token);
    expect(getAppWorkloadCredentialHealth()).toEqual({ status: "ready", source: "runtime" });
    reply = { status: "current", credentialId };
    await runtime.refresh();
    expect(requests.at(-1)).toEqual({ operation: "refresh", appId: "inventory", instanceId, credentialId });
    expect(getAppWorkloadCredential()).toBe(token);
    const rotated = `cld_${"c".repeat(24)}_${"d".repeat(64)}`;
    reply = { ...issued, token: rotated };
    await runtime.refresh();
    expect(getAppWorkloadCredential()).toBe(rotated);
    await runtime.stop();
    expect(requests.at(-1)?.operation).toBe("release");
    expect(getAppWorkloadCredential()).toBeUndefined();
    runtime = undefined;
  });

  test("startup completes fail-closed when Core is unavailable and recovers on the next refresh", async () => {
    let reply: unknown = { status: "unavailable" };
    runtime = createAppWorkloadCredential({ appId: "inventory", instanceId, request: async () => reply });
    await runtime.start();
    expect(getAppWorkloadCredential()).toBeUndefined();
    expect(getAppWorkloadCredentialHealth()).toEqual({ status: "unavailable", reason: "unavailable" });
    reply = issued;
    await runtime.refresh();
    expect(getAppWorkloadCredential()).toBe(token);
  });

  test("an explicit env override wins without issuing or releasing runtime credentials", async () => {
    Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", { value: " explicit-host-token ", configurable: true });
    let requests = 0;
    runtime = createAppWorkloadCredential({
      appId: "inventory",
      instanceId,
      request: async () => {
        requests++;
        throw new Error("must not call");
      },
    });
    await runtime.start();
    expect(getAppWorkloadCredential()).toBe("explicit-host-token");
    expect(getAppWorkloadCredentialHealth()).toEqual({ status: "ready", source: "override" });
    await runtime.stop();
    expect(requests).toBe(0);
    runtime = undefined;
  });

  test("transient refresh failure serves the valid token, degrades at expiry, and recovers once", async () => {
    const reasons: string[] = [];
    let fail = false;
    let recoveries = 0;
    let reply: unknown = issued;
    runtime = createAppWorkloadCredential({
      appId: "inventory",
      instanceId,
      onUnavailable: (reason) => reasons.push(reason),
      onRecovered: () => recoveries++,
      request: async () => {
        if (fail) throw new Error("private server detail");
        return reply;
      },
    });
    await runtime.start();
    fail = true;
    await runtime.refresh();
    expect(getAppWorkloadCredential()).toBe(token);
    expect(getAppWorkloadCredentialHealth()).toEqual({ status: "ready", source: "runtime" });
    expect(reasons).toEqual([]);
    reply = { status: "unavailable" };
    fail = false;
    await runtime.refresh();
    expect(getAppWorkloadCredential()).toBe(token);
    setSystemTime(new Date("2026-10-29T13:00:01Z"));
    await runtime.refresh();
    expect(getAppWorkloadCredential()).toBeUndefined();
    expect(reasons).toEqual(["unavailable"]);
    const readiness = appReadinessResponse("inventory");
    expect(readiness.status).toBe(200);
    expect(await readiness.json()).not.toHaveProperty("workloadCredential");
    reply = { ...issued, expiresAt: "2026-10-29T14:00:00Z" };
    await runtime.refresh();
    await runtime.refresh();
    expect(recoveries).toBe(1);
    expect(getAppWorkloadCredential()).toBe(token);
    reply = { status: "revoked" };
    await runtime.refresh();
    expect(getAppWorkloadCredential()).toBeUndefined();
    expect(getAppWorkloadCredentialHealth()).toEqual({ status: "unavailable", reason: "revoked" });
  });

  test("rejects other app/instance material, Core secrets, malformed replies, and expired credentials", async () => {
    let reply: unknown = { ...issued, appId: "other" };
    runtime = createAppWorkloadCredential({ appId: "inventory", instanceId, request: async () => reply });
    await runtime.start();
    expect(getAppWorkloadCredential()).toBeUndefined();
    for (const invalid of [
      { ...issued, instanceId: "other-instance" },
      { ...issued, signingKey: "must-never-be-delivered" },
      { ...issued, expiresAt: "2026-10-29T11:00:00Z" },
    ]) {
      reply = invalid;
      await runtime.refresh();
      expect(getAppWorkloadCredential()).toBeUndefined();
    }
    reply = issued;
    await runtime.refresh();
    setSystemTime(new Date("2026-10-29T13:00:01Z"));
    expect(getAppWorkloadCredential()).toBeUndefined();
    expect(getAppWorkloadCredentialHealth()).toEqual({ status: "unavailable", reason: "expired" });
  });
});
