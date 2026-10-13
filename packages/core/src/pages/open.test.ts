import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { resolveCloudResourceHref } from "@k2b/cloud/api";
import type { AuthContext } from "@k2b/cloud/server";
import { session } from "@k2b/cloud/services";
import * as railSnapshot from "@k2b/cloud/services/rail-snapshot";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import type { RuntimeContext } from "@k2b/cloud/ssr";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "core-resource-links-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
const { createResourceOpenRoutes } = await import("./open");
const tokenSpy = spyOn(session, "getToken").mockReturnValue(null);
const railSpy = spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue({
  revision: 0,
  visibility: {},
  shortcuts: [],
  managedShortcuts: [],
});
const sessionSpy = spyOn(session, "authenticateRequest").mockResolvedValue(null);
afterEach(() => {
  tokenSpy.mockReturnValue(null);
  sessionSpy.mockResolvedValue(null);
});
afterAll(() => {
  tokenSpy.mockRestore();
  sessionSpy.mockRestore();
  railSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});
const user = buildProjectedUser({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "local",
  profile: "user",
  uid: "reader",
  display_name: "Reader",
});
const signIn = () => {
  tokenSpy.mockReturnValue("test-session");
  sessionSpy.mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
};
const routes = (resolve: typeof resolveCloudResourceHref) =>
  new Hono<AuthContext & { Variables: { runtime: RuntimeContext } }>()
    .use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    })
    .route("/open", createResourceOpenRoutes(resolve));

test("redirects the signed-in user with decoded identity and the normal session authority", async () => {
  signIn();
  let invocation: Parameters<typeof resolveCloudResourceHref>[0] | undefined;
  const response = await routes(async (params) => {
    invocation = params;
    return "/app/mail/box?draft=AbC123";
  }).request("https://cloud.example/open/mail.draft/a%2Fb%3Fc%23d%20%C3%BC");
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/app/mail/box?draft=AbC123");
  expect(invocation?.ref).toEqual({ type: "mail.draft", id: "a/b?c#d ü" });
  expect(invocation?.authority).toEqual({
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "session",
    scopes: [],
  });
});

test("returns Core's existing localized NotFound page when resolution fails", async () => {
  signIn();
  const response = await routes(async () => null).request("https://cloud.example/open/mail.draft/missing");
  expect(response.status).toBe(404);
  expect(await response.text()).toContain("Nothing here");
});

test("redirects signed-out users to the normal sign-in flow with the permalink as return target", async () => {
  let called = false;
  const response = await routes(async () => {
    called = true;
    return "/app/mail";
  }).request("https://cloud.example/open/mail.draft/AbC123");
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "", "https://cloud.example");
  expect(location.pathname).toBe("/auth/login");
  expect(location.searchParams.get("redirectTo")).toBe("/open/mail.draft/AbC123");
  expect(called).toBe(false);
});
