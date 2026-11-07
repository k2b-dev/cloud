import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeCheckedVersionManifest, UserSchema } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as server from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import type { requestCodeRoute } from "./requests";
import { checkCodeCsrf, codeCsrf } from "./route-security";

const root = mkdtempSync(join(tmpdir(), "core-code-hosting-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
const { createCodeHostingRoutes, readCodeRequestBody } = await import("./hosting");

const codeId = "c_routehost";
const id = "11111111-1111-4111-8111-111111111111";
const person = UserSchema.parse({
  id,
  uid: "visitor",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Person",
  displayName: "Test Person",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function hosting(
  isPublic = false,
  signed = false,
  response: Awaited<ReturnType<typeof requestCodeRoute>> = { kind: "json", status: 200, body: '{"returned":true}' },
) {
  const rate = spyOn(server, "ratelimit").mockImplementation(({ id }) => ({
    id,
    check: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
    checkOrThrow: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
  }));
  const groups = spyOn(server, "getEffectiveGroups").mockResolvedValue([{ id: "group", name: "Group" }]);
  restores.push(
    () => rate.mockRestore(),
    () => groups.mockRestore(),
  );
  const route = { method: "ALL" as const, path: "/", public: isPublic };
  const manifest: CodeCheckedVersionManifest = {
    version: 1,
    entry: "code.ts",
    entrypoints: [{ kind: "route", entrypoint: "route:ALL:/", route, cron: null, file: "code.ts", line: 1 }],
    permissions: [],
    ai: false,
    policyRows: isPublic ? ["public_routes"] : [],
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
  };
  const calls: Parameters<typeof requestCodeRoute>[0][] = [];
  const router = new Hono<AuthContext>();
  // Test the route after the same resolved authority that the framework supplies.
  if (signed)
    router.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user: person });
      c.set("accessSubject", { type: "user", userId: id });
      c.set("credentialKind", "session");
      c.set("sessionToken", "fixture-session");
      return next();
    });
  router.route(
    "/",
    createCodeHostingRoutes({
      version: async () => ({ versionId: "version", manifest }),
      request: async (input) => {
        calls.push(input);
        return response;
      },
    }),
  );
  return { router, calls, rate };
}
test("signed-in pages receive only the visitor projection; unsigned requests never reach the runner", async () => {
  const privatePage = hosting();
  expect((await privatePage.router.request(`/code/${codeId}/`)).status).toBe(401);
  expect(privatePage.calls).toHaveLength(0);
  const signed = hosting(false, true);
  const response = await signed.router.request(`/code/${codeId}/`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ returned: true });
  expect(signed.calls[0]?.request.user).toEqual({ id, groups: ["group"] });
  expect(JSON.stringify(signed.calls)).not.toContain("fixture-session");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("public handlers are anonymous even for signed-in people and return exactly Code data", async () => {
  const page = hosting(true, true);
  const response = await page.router.request(`/code/${codeId}/`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ returned: true });
  expect(page.calls[0]?.request.user).toBeNull();
  expect(page.rate).toHaveBeenCalled();
});
test("POST, PUT and DELETE require a CSRF token bound to this session and Code", async () => {
  const page = hosting(false, true);
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const token of [undefined, codeCsrf("other-session", codeId), codeCsrf("fixture-session", "other-code")]) {
      expect((await page.router.request(`/code/${codeId}/`, { method, headers: token ? { "X-Code-CSRF": token } : {} })).status).toBe(403);
    }
    expect(
      (await page.router.request(`/code/${codeId}/`, { method, headers: { "X-Code-CSRF": codeCsrf("fixture-session", codeId) } })).status,
    ).toBe(200);
  }
  expect(page.calls).toHaveLength(3);
});
test("public forms bind to an HttpOnly cookie and remove the CSRF field before executing Code", async () => {
  const page = hosting(true);
  const get = await page.router.request(`/code/${codeId}/`);
  const cookie = get.headers.get("set-cookie")!.split(";", 1)[0]!;
  expect(get.headers.get("set-cookie")).toContain("HttpOnly");
  const token = get.headers.get("X-Code-CSRF")!;
  const post = await page.router.request(`/code/${codeId}/`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: token, value: "one" }),
  });
  expect(post.status).toBe(200);
  expect(page.calls[1]?.request.body).toBe("value=one");
  expect(page.calls[1]?.request.user).toBeNull();
});
test("streamed bodies, not only advertised sizes, stay within the request budget", async () => {
  const request = new Request("https://cloud.example/", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    }),
  });
  await expect(readCodeRequestBody(request, 10, new AbortController().signal)).rejects.toThrow("code_request_size_limit");
  expect(checkCodeCsrf(undefined, codeId, "x")).toBe(false);
});
test("foreign redirects fail; own redirects remain inside this Code", async () => {
  const foreign = hosting(false, true, { kind: "redirect", status: 303, location: "https://evil.example" });
  expect((await foreign.router.request(`/code/${codeId}/`)).status).toBe(503);
  const own = hosting(false, true, { kind: "redirect", status: 303, location: "/next" });
  expect((await own.router.request(`/code/${codeId}/`)).headers.get("Location")).toBe(`/code/${codeId}/next`);
});

test("hosting middleware leaves neighbouring Core pages alone", async () => {
  const page = hosting();
  page.router.get("/me", (c) => c.text("Profile", 200, { "Cache-Control": "private" }));
  const response = await page.router.request("/me");
  expect(response.headers.get("Cache-Control")).toBe("private");
  expect(response.headers.get("X-Code-CSRF")).toBeNull();
});
test("public overload returns 429 without dispatching", async () => {
  const page = hosting(true);
  page.rate.mockImplementation(({ id }) => ({
    id,
    check: async () => ({ limited: true, remaining: 0, resetIn: 60_000 }),
    checkOrThrow: async () => ({ limited: true, remaining: 0, resetIn: 60_000 }),
  }));
  const response = await page.router.request(`/code/${codeId}/`);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(page.calls).toHaveLength(0);
});

test("invalid UTF-8 and an expanded form never reach a handler", async () => {
  const page = hosting(false, true);
  const headers = { "X-Code-CSRF": codeCsrf("fixture-session", codeId) };
  expect((await page.router.request(`/code/${codeId}/`, { method: "POST", headers, body: new Uint8Array([0xff]) })).status).toBe(400);
  expect(
    (
      await page.router.request(`/code/${codeId}/`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: `x=${"!".repeat(3000)}`,
      })
    ).status,
  ).toBe(413);
  expect(page.calls).toHaveLength(0);
});

test("a cancelled request stops waiting on a dependency before dispatch", async () => {
  const router = new Hono<AuthContext>();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let dispatched = false;
  router.route(
    "/",
    createCodeHostingRoutes({
      version: () => {
        entered();
        return new Promise(() => {});
      },
      request: async () => {
        dispatched = true;
        return { kind: "text", status: 200, body: "x" };
      },
    }),
  );
  const cancel = new AbortController();
  const result = router.request(new Request(`https://cloud.test/code/${codeId}/`, { signal: cancel.signal }));
  await waiting;
  cancel.abort();
  expect((await result).status).toBe(504);
  expect(dispatched).toBe(false);
});
