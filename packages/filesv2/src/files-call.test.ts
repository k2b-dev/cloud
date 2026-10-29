import { expect, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { AuthContext, RequestActor } from "@k2b/cloud/server";
import { Hono } from "hono";
import { testActor } from "../test/files-call";
import { capabilityCall, requestCall } from "./files-call";
import { systemCall, visitorCall } from "./service/activity";

if (testActor.kind !== "user") throw new Error("expected user fixture");
const actor = testActor;
const delegation = {
  kind: "invocation",
  callingAppId: "notebooks",
  credentialKind: "session",
  invocationId: "invoke-1",
  requestId: "delegated-request",
} as const;
async function request(
  input: { actor?: RequestActor; credential?: AuthContext["Variables"]["credentialKind"]; session?: "app"; requestId?: string } = {},
) {
  const subject = { type: "user", userId: actor.user.id } as const;
  const app = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("actor", input.actor ?? actor);
      c.set("accessSubject", subject);
      c.set("credentialKind", input.credential ?? "session");
      c.set("sessionKind", input.session);
      await next();
    })
    .get("/", (c) => c.json(requestCall(c)));
  const response = await app.request("/", { headers: input.requestId === undefined ? {} : { "x-request-id": input.requestId } });
  return response.json();
}
test("web sessions preserve actor, grant subject, and request id", async () => {
  expect(await request({ requestId: "request-1" })).toEqual({
    kind: "user",
    actor,
    accessSubject: { type: "user", userId: actor.user.id },
    via: "web",
    requestId: "request-1",
    origin: null,
    invocationId: null,
    callingApp: null,
  });
});
test("request IDs are bounded and take precedence over delegated IDs", async () => {
  expect(await request({ actor: { ...actor, delegation }, requestId: "x".repeat(80) })).toMatchObject({ requestId: "x".repeat(64) });
  expect(await request({ actor: { ...actor, delegation } })).toMatchObject({
    requestId: "delegated-request",
    via: "app:notebooks",
    callingApp: "notebooks",
    invocationId: "invoke-1",
  });
});
test.each(["oauth", "api_key"] as const)("%s is api until OAuth clients are forwarded", async (credential) =>
  expect(await request({ credential })).toMatchObject({ via: "api" }),
);
test("app session context or actor marker selects app", async () => {
  expect(await request({ session: "app" })).toMatchObject({ via: "app" });
  expect(await request({ actor: { ...actor, sessionKind: "app" } })).toMatchObject({ via: "app" });
});
test.each([{ mandateId: "mandate" }, { workloadType: "job" }])("invocation agent markers override app attribution: %j", async (marker) =>
  expect(await request({ actor: { ...actor, delegation: { ...delegation, ...marker } } })).toMatchObject({ via: "agent" }),
);
const context: CapabilityExecutionContext = {
  actor,
  accessSubject: { type: "user", userId: actor.user.id },
  user: actor.user,
  locale: "en",
  origin: "http",
  requestId: "cap-request",
  signal: new AbortController().signal,
};
test("capability context keeps the platform request and origin", () => {
  expect(capabilityCall(context)).toEqual({
    kind: "user",
    actor,
    accessSubject: context.accessSubject,
    via: "api",
    requestId: "cap-request",
    origin: "http",
    invocationId: null,
    callingApp: null,
  });
  expect(capabilityCall({ ...context, actor: { ...actor, delegation } })).toMatchObject({
    via: "app:notebooks",
    callingApp: "notebooks",
    invocationId: "invoke-1",
  });
});
test("Assistant, mandates, and workloads select agent", () => {
  expect(capabilityCall({ ...context, origin: "assistant", actor: { ...actor, delegation } }).via).toBe("agent");
  for (const marker of [{ mandateId: "mandate" }, { workloadType: "task" }])
    expect(capabilityCall({ ...context, actor: { ...actor, delegation: { ...delegation, ...marker } } }).via).toBe("agent");
});
test("machine capability actors preserve their own identity and subject", () => {
  const serviceActor: RequestActor = {
    kind: "service_account",
    delegatedUser: null,
    scopes: [],
    serviceAccount: {
      id: "account",
      kind: "standalone",
      name: "test",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
  };
  const call = capabilityCall({
    ...context,
    actor: serviceActor,
    user: null,
    accessSubject: { type: "service_account", serviceAccountId: "account" },
  });
  expect(call.actor).toEqual(serviceActor);
  expect(call.accessSubject).toEqual({ type: "service_account", serviceAccountId: "account" });
});
test("visitor and system builders preserve their explicit purpose", () => {
  expect(visitorCall("share", "request")).toEqual({ kind: "visitor", shareId: "share", requestId: "request" });
  expect(systemCall("maintenance")).toEqual({ kind: "system", job: "maintenance" });
});
