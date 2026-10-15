import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { resolveCloudResourceHref } from "@k2b/cloud/api";
import { cloudResourceHref } from "@k2b/cloud/contracts";
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
  }).request(new URL(cloudResourceHref({ type: "mail.draft", id: "a/b?c#d ü" }), "https://cloud.example"));
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
  const response = await routes(async () => null).request(
    new URL(cloudResourceHref({ type: "mail.draft", id: "missing" }), "https://cloud.example"),
  );
  expect(response.status).toBe(404);
  expect(await response.text()).toContain("Nothing here");
});

test("redirects signed-out users to the normal sign-in flow with the permalink as return target", async () => {
  let called = false;
  const response = await routes(async () => {
    called = true;
    return "/app/mail";
  }).request(new URL(cloudResourceHref({ type: "mail.draft", id: "AbC123" }), "https://cloud.example"));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "", "https://cloud.example");
  expect(location.pathname).toBe("/auth/login");
  expect(location.searchParams.get("redirectTo")).toBe("/open/mail.draft/~AbC123");
  expect(called).toBe(false);
});

test.each([".", "..", "~", "東京".repeat(256), "ü".repeat(512)])("resolves the original id after URL normalization: %s", async (id) => {
  signIn();
  let resolved: string | undefined;
  const response = await routes(async ({ ref }) => {
    resolved = ref.id;
    return "/app/demo";
  }).request(new URL(cloudResourceHref({ type: "demo.item", id }), "https://cloud.example"));
  expect(response.status).toBe(302);
  expect(resolved).toBe(id);
});

test("returns 404 without resolving an id segment missing the required prefix", async () => {
  signIn();
  let called = false;
  const response = await routes(async () => {
    called = true;
    return "/app/mail";
  }).request("https://cloud.example/open/mail.draft/AbC123");
  expect(response.status).toBe(404);
  expect(await response.text()).toContain("Nothing here");
  expect(called).toBe(false);
});
