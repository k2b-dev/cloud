import { afterEach, expect, spyOn, test } from "bun:test";
import * as api from "@k2b/cloud/api";
import { RUNNER_PATHS } from "@k2b/cloud/code/runner";
import type { AuthContext } from "@k2b/cloud/server";
import { appPublicRouteMatcher, requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { Hono } from "hono";
import { app } from "../config";
import * as chat from "./chat-runner";
import { createCodeRunnerRoutes } from "./runner-routes";

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("every Runner protocol path reaches its route-owned authentication through the Core envelope", () => {
  const matches = appPublicRouteMatcher(app.meta);
  for (const path of Object.values(RUNNER_PATHS)) {
    expect({ path, specialized: matches(path) }).toEqual({ path, specialized: true });
    expect(matches(`${path}/private`)).toBe(false);
  }
});

test("the chat job bridge keeps its result and route authentication under the Core envelope", async () => {
  const authenticated = spyOn(api, "authenticateSignedAppRequest").mockResolvedValue({
    appId: "runner",
    serviceAccountId: "11111111-1111-4111-8111-111111111111",
    credentialId: "22222222-2222-4222-8222-222222222222",
    scope: "identity:invoke",
  });
  const call = spyOn(chat, "callChatJob").mockResolvedValue({ ok: true, value: ["json", 42] });
  spies.push(authenticated, call);
  const router = new Hono<AuthContext>()
    .use(requireAppAccess(app.meta, async () => new Response(null, { status: 403 })))
    .route("/", createCodeRunnerRoutes());
  const body = {
    jobId: "33333333-3333-4333-8333-333333333333",
    generation: 1,
    leaseKey: "a".repeat(64),
    id: "44444444-4444-4444-8444-444444444444",
    operation: "chat.message",
    input: [],
  };
  const request = () => router.request(RUNNER_PATHS.jobCall, { method: "POST", body: JSON.stringify(body) });
  expect(await (await request()).json()).toEqual({ ok: true, value: ["json", 42] });
  expect(call).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  call.mockClear();
  authenticated.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect((await request()).status).toBe(401);
  authenticated.mockResolvedValueOnce({
    appId: "mail",
    serviceAccountId: "11111111-1111-4111-8111-111111111111",
    credentialId: "22222222-2222-4222-8222-222222222222",
    scope: "identity:invoke",
  });
  expect((await request()).status).toBe(403);
  expect(call).not.toHaveBeenCalled();
});
