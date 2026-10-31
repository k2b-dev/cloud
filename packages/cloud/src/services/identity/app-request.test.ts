import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { APP_KEY_FIXTURES } from "../../../../../scripts/fixtures/app-key-fixtures";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import { type AppKey, formatAppKey, importAppPublicKey } from "../../app-key";
import { invokeCapability } from "../../capabilities/server-invoke";
import { env } from "../../config/env";
import { bootstrapBodyDigest } from "../../runtime/bootstrap-protocol";
import { sendAppRequest } from "./app-request";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const key: AppKey = {
  installationId: "11111111-1111-4111-8111-111111111111",
  appId: "mail",
  keyId: "22222222-2222-4222-8222-222222222222",
  seed: APP_KEY_FIXTURES[0].seed,
};
const keyDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
const originDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_CORE_INTERNAL_ORIGIN")!;
beforeEach(() => {
  setSystemTime(NOW);
  Object.defineProperty(env, "CLOUD_APP_KEY", { value: formatAppKey(key), configurable: true });
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", { value: "http://core.test", configurable: true });
  bindProcessApplicationId("mail");
});
afterEach(() => {
  Object.defineProperty(env, "CLOUD_APP_KEY", keyDescriptor);
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", originDescriptor);
  clearProcessApplicationId();
  setSystemTime();
});

test("a run signs each final request and an explicit retry with new nonces and unchanged domain idempotency", async () => {
  const proofs: string[] = [];
  const bodies: string[] = [];
  let calls = 0;
  const transport = async (request: Request) => {
    calls++;
    expect(request.redirect).toBe("error");
    const proof = request.headers.get("authorization")!.slice(7);
    const body = await request.text();
    const { payload } = await jwtVerify(proof, await importAppPublicKey(APP_KEY_FIXTURES[0].publicKey), {
      algorithms: ["EdDSA"],
      typ: "cloud-app+jwt",
      currentDate: new Date(NOW),
    });
    expect(payload).toMatchObject({
      iss: "mail",
      sub: "mail",
      aud: `cloud-core:${key.installationId}`,
      htm: "POST",
      htu: "/api/_internal/identity/v1/invoke",
      bdh: await bootstrapBodyDigest(new TextEncoder().encode(body)),
    });
    expect(decodeProtectedHeader(proof).kid).toBe(key.keyId);
    proofs.push(proof);
    bodies.push(body);
    if (calls === 1) throw new TypeError("response lost");
    return Response.json({ data: { id: "created" } });
  };
  const caller = {
    mandate: { id: "33333333-3333-4333-8333-333333333333", revision: 1, callingAppId: "mail" },
    requestId: "run-1",
    transport,
  };
  const invocation = {
    appId: "spaces",
    capabilityId: "event.create",
    kind: "action" as const,
    input: { title: "One" },
    idempotencyKey: "effect-1",
  };
  expect(await invokeCapability(invocation, caller)).toMatchObject({ ok: false });
  expect(await invokeCapability(invocation, caller)).toMatchObject({ ok: true });
  expect(await invokeCapability({ ...invocation, input: { title: "Two" }, idempotencyKey: "effect-2" }, caller)).toMatchObject({
    ok: true,
  });
  expect(new Set(proofs.map((proof) => decodeJwt(proof).jti)).size).toBe(3);
  expect(bodies[0]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0]!)).toMatchObject({ idempotencyKey: "effect-1", metadata: { requestId: "run-1" } });
  expect(JSON.parse(bodies[2]!)).toMatchObject({ idempotencyKey: "effect-2", input: { title: "Two" } });
});

test("a configured app key takes precedence over a bearer and is never replaced after rejection", async () => {
  let calls = 0;
  const result = await invokeCapability(
    { appId: "spaces", capabilityId: "item.readable", kind: "query", input: {} },
    {
      workload: { appId: "mail" },
      authorization: "Bearer obsolete",
      transport: async (request) => {
        calls++;
        expect(decodeJwt(request.headers.get("authorization")!.slice(7)).iss).toBe("mail");
        return Response.json({ code: "UNAUTHORIZED" }, { status: 401, headers: { "x-cloud-workload-auth": "required" } });
      },
    },
  );
  expect(calls).toBe(1);
  expect(result).toMatchObject({ ok: false, error: { status: 401 } });
});

test("a configured wrong or malformed key fails before send without evaluating a legacy credential", async () => {
  for (const value of ["malformed", formatAppKey({ ...key, appId: "oauth" })]) {
    Object.defineProperty(env, "CLOUD_APP_KEY", { value, configurable: true });
    let sent = false;
    await expect(
      sendAppRequest(new Request("http://core.test/invoke"), {
        appId: "mail",
        bearer: () => {
          throw new Error("fallback");
        },
        transport: async () => {
          sent = true;
          return new Response();
        },
      }),
    ).rejects.toThrow();
    expect(sent).toBe(false);
  }
});

test("the sender sets app identity for both signed and legacy requests", async () => {
  for (const value of [formatAppKey(key), undefined]) {
    Object.defineProperty(env, "CLOUD_APP_KEY", { value, configurable: true });
    const response = await sendAppRequest(new Request("http://core.test/invoke"), {
      appId: "mail",
      bearer: () => "workload-secret",
      transport: async (request) => {
        expect(request.headers.get("X-Cloud-App-Id")).toBe("mail");
        if (!value) expect(request.headers.get("authorization")).toBe("Bearer workload-secret");
        return new Response(null, { status: 204 });
      },
    });
    expect(response.status).toBe(204);
  }
});

test("invalid or conflicting app identity fails before signing, credential lookup, or transport", async () => {
  for (const value of [formatAppKey(key), undefined]) {
    Object.defineProperty(env, "CLOUD_APP_KEY", { value, configurable: true });
    for (const input of [
      { appId: "invalid id", headers: new Headers() },
      { appId: "mail", headers: new Headers({ "X-Cloud-App-Id": "chat" }) },
    ]) {
      let credentialCalls = 0;
      let sends = 0;
      await expect(
        sendAppRequest(new Request("http://core.test/invoke", { headers: input.headers }), {
          appId: input.appId,
          bearer: () => {
            credentialCalls++;
            return "workload-secret";
          },
          transport: async () => {
            sends++;
            return new Response();
          },
        }),
      ).rejects.toThrow();
      expect(credentialCalls).toBe(0);
      expect(sends).toBe(0);
    }
  }
});
