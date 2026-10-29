import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import { createAppWorkloadCredential } from "../_internal/workload-credential";
import { env } from "../config/env";
import { invokeCapability } from "./server-invoke";

const instanceId = "0123456789abcdef";
const credentialId = "12345678-1234-4234-8234-123456789abc";
const token = `cld_${"a".repeat(24)}_${"b".repeat(64)}`;
const rotated = `cld_${"c".repeat(24)}_${"d".repeat(64)}`;
const issued = { status: "issued", appId: "mail", instanceId, credentialId, token, expiresAt: "2026-10-29T13:00:00Z" };
const originalOverride = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_CREDENTIAL")!;
const origin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
let runtime: ReturnType<typeof createAppWorkloadCredential> | undefined;
beforeEach(() => {
  setSystemTime(new Date("2026-10-29T12:00:00Z"));
  Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", { value: undefined, configurable: true });
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal";
  bindProcessApplicationId("mail");
});
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  Object.defineProperty(env, "CLOUD_APP_CREDENTIAL", originalOverride);
  if (origin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = origin;
  clearProcessApplicationId();
  setSystemTime();
});
const rejection = () =>
  Response.json(
    { code: "UNAUTHORIZED", message: "Workload credential required" },
    {
      status: 401,
      headers: { "x-cloud-workload-auth": "required" },
    },
  );
for (const outcome of ["recovered", "revoked", "transient", "target-401"] as const) {
  test(`shared workload client handles ${outcome} without terminal credential failure or unsafe target retries`, async () => {
    let refreshes = 0;
    runtime = createAppWorkloadCredential({
      appId: "mail",
      instanceId,
      request: async () => {
        refreshes++;
        if (refreshes === 1) return issued;
        if (outcome === "revoked") return { status: "revoked" };
        if (outcome === "transient") return { status: "unavailable" };
        return { ...issued, token: rotated };
      },
    });
    await runtime.start();
    const requests: { authorization: string | null; body: string }[] = [];
    const result = await invokeCapability(
      { appId: "spaces", capabilityId: "event.create", kind: "action", input: { title: "One" } },
      {
        authorization: `Bearer ${token}`,
        mandate: { id: credentialId, revision: 1, callingAppId: "mail" },
        transport: async (request) => {
          requests.push({ authorization: request.headers.get("authorization"), body: await request.text() });
          if (outcome === "target-401") return Response.json({ code: "UNAUTHORIZED", message: "Subject denied" }, { status: 401 });
          if (requests.length === 1 || outcome !== "recovered") return rejection();
          return Response.json({ data: { id: "one" } });
        },
      },
    );
    if (outcome === "target-401") {
      expect(requests).toHaveLength(1);
      expect(refreshes).toBe(1);
      expect(result).toMatchObject({ ok: false, error: { status: 401 } });
    } else {
      expect(requests).toHaveLength(2);
      expect(refreshes).toBe(2);
      expect(requests[1]?.body).toBe(requests[0]?.body);
      if (outcome === "recovered") {
        expect(requests[1]?.authorization).toBe(`Bearer ${rotated}`);
        expect(result).toMatchObject({ ok: true });
      } else expect(result).toMatchObject({ ok: false, error: { code: "APP_UNAVAILABLE", status: 503 } });
    }
  });
}
