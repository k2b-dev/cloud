import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodeCheckedVersionManifest, type User, UserSchema } from "@k2b/cloud/contracts";
import type { AuthContext, RequestActor } from "@k2b/cloud/server";
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
  personalOwner: string | null = null,
  visitor: User = person,
  workload?: Extract<RequestActor, { kind: "service_account" }>,
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
  if (signed || workload)
    router.use("*", async (c, next) => {
      c.set("actor", workload ?? { kind: "user", user: visitor });
      c.set(
        "accessSubject",
        workload ? { type: "service_account", serviceAccountId: workload.serviceAccount.id } : { type: "user", userId: visitor.id },
      );
      c.set("credentialKind", workload ? "api_key" : "session");
      c.set("sessionToken", "fixture-session");
      return next();
    });
  router.route(
    "/",
    createCodeHostingRoutes({
      version: async () => ({ versionId: "version", manifest, personalOwner }),
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
  expect(signed.calls[0]?.request.user).toEqual({
    id,
    username: "visitor",
    groupIds: ["group"],
    groupNames: ["Group"],
    kind: "user",
    name: "Test Person",
  });
  expect(JSON.stringify(signed.calls)).not.toContain("fixture-session");
  expect(response.headers.get("cache-control")).toContain("no-store");
});
test("a browser visitor without a session goes to sign-in and comes back to the page; requests keep the stable code", async () => {
  const privatePage = hosting();
  const opened = await privatePage.router.request(`/code/${codeId}/?week=45`, { headers: { Accept: "text/html" } });
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toBe(`/auth/login?redirectTo=${encodeURIComponent(`/code/${codeId}/?week=45`)}`);
  const island = await privatePage.router.request(`/code/${codeId}/`, { headers: { Accept: "text/html", "X-Code-Page": "tree" } });
  expect(island.status).toBe(401);
  expect(await island.json()).toEqual({ code: "code_sign_in_required" });
  expect((await privatePage.router.request(`/code/${codeId}/`, { method: "POST", headers: { Accept: "text/html" } })).status).toBe(401);
  expect(privatePage.calls).toHaveLength(0);
});
test("each account profile and provider reaches the handler as a stable, minimal visitor identity", async () => {
  for (const profile of ["user", "guest"] as const) {
    for (const provider of ["local", "ipa"] as const) {
      const visitor = UserSchema.parse({
        ...person,
        profile,
        provider,
        displayName: "Visitor Name",
        mail: "private@example.test",
        ipa:
          provider === "ipa"
            ? {
                uidNumber: 1234,
                phone: null,
                employeeType: null,
                mobile: null,
                address: { street: null, postalCode: null, city: null, state: null },
                passwordExpires: null,
                lastLoginIpa: null,
                syncedAt: null,
                sshPublicKeys: ["private-directory-value"],
                sshFingerprints: [],
              }
            : null,
      });
      const page = hosting(false, true, undefined, null, visitor);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((await page.router.request(`/code/${codeId}/`, { headers: { "X-Provider-Token": "provider-secret" } })).status).toBe(200);
        expect(page.calls[attempt]?.request.user).toEqual({
          id,
          username: "visitor",
          groupIds: ["group"],
          groupNames: ["Group"],
          kind: profile,
          name: "Visitor Name",
        });
      }
      const payload = JSON.stringify(page.calls);
      for (const secret of ["fixture-session", "provider-secret", "private@example.test", "private-directory-value"])
        expect(payload).not.toContain(secret);
    }
  }
});
test("service accounts and agents cannot become page visitors", async () => {
  for (const kind of ["user_delegated", "resource_bound", "standalone", "agent", "code"] as const) {
    const workload: Extract<RequestActor, { kind: "service_account" }> = {
      kind: "service_account",
      serviceAccount: {
        id: "account",
        name: "Account",
        kind,
        status: "active",
        delegatedUserId: null,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: null,
        createdAt: "2026-11-08T00:00:00Z",
      },
      delegatedUser: null,
      scopes: [],
    };
    const privatePage = hosting(false, false, undefined, null, person, workload);
    expect((await privatePage.router.request(`/code/${codeId}/`)).status).toBe(401);
    expect(privatePage.calls).toHaveLength(0);
    const publicPage = hosting(true, false, undefined, null, person, workload);
    expect((await publicPage.router.request(`/code/${codeId}/`)).status).toBe(200);
    expect(publicPage.calls[0]?.request.user).toBeNull();
  }
});
test("signed-in visitors share a bounded request budget by UID before runner admission", async () => {
  const page = hosting(false, true);
  const keys: string[] = [];
  page.rate.mockImplementation(({ id }) => ({
    id,
    check: async (key: string) => {
      keys.push(key);
      return { limited: true, remaining: 0, resetIn: 60 };
    },
    checkOrThrow: async () => ({ limited: true, remaining: 0, resetIn: 60 }),
  }));
  const response = await page.router.request(`/code/${codeId}/`);
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(keys).toEqual([`user:${person.id}`]);
  expect(page.calls).toHaveLength(0);
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

test("personal Code pages open for every signed-in person; public pages have no visitor identity", async () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const foreign = hosting(false, true, undefined, other);
  const refused = await foreign.router.request(`/code/${codeId}/`);
  expect(refused.status).toBe(200);
  expect(foreign.calls[0]?.request.user?.id).toBe(id);
  expect((await hosting(false, false, undefined, id).router.request(`/code/${codeId}/`)).status).toBe(401);
  const owner = hosting(false, true, undefined, id);
  expect((await owner.router.request(`/code/${codeId}/`)).status).toBe(200);
  expect(owner.calls[0]?.request.user).toEqual({
    id,
    username: "visitor",
    groupIds: ["group"],
    groupNames: ["Group"],
    kind: "user",
    name: "Test Person",
  });
  const open = hosting(true, true, undefined, other);
  expect((await open.router.request(`/code/${codeId}/`)).status).toBe(200);
  expect(open.calls[0]?.request.user).toBeNull();
});

test("the island receives a checked tree only from hosting, never Code JSON shaped like one", async () => {
  const tree = { version: 1, kind: "Page", title: "Workshop", children: [{ kind: "Text", text: "Ready" }] };
  const page = hosting(false, true, { kind: "page", status: 200, tree });
  const answer = await page.router.request(`/code/${codeId}/`, { headers: { "X-Code-Page": "tree" } });
  expect(answer.headers.get("X-Code-Page")).toBe("tree");
  expect(answer.headers.get("Vary")).toContain("X-Code-Page");
  expect(await answer.json()).toEqual({ tree, csrf: codeCsrf("fixture-session", codeId) });
  const spoof = hosting(false, true, { kind: "json", status: 200, body: JSON.stringify({ tree, csrf: "x" }) });
  const data = await spoof.router.request(`/code/${codeId}/`, { headers: { "X-Code-Page": "tree" } });
  expect(data.headers.get("X-Code-Page")).toBeNull();
  const invalid = hosting(false, true, { kind: "page", status: 200, tree: { ...tree, children: [{ kind: "HTML" }] } });
  expect((await invalid.router.request(`/code/${codeId}/`, { headers: { "X-Code-Page": "tree" } })).status).toBe(503);
});

test("a submit from the island still needs the CSRF field of this session and Code", async () => {
  const tree = { version: 1, kind: "Page", title: "Saved", children: [] };
  const page = hosting(false, true, { kind: "page", status: 200, tree });
  const post = (fields: Record<string, string>) =>
    page.router.request(`/code/${codeId}/`, {
      method: "POST",
      headers: { "X-Code-Page": "tree", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  expect((await post({ value: "one" })).status).toBe(403);
  expect((await post({ _csrf: codeCsrf("other-session", codeId), value: "one" })).status).toBe(403);
  expect(page.calls).toHaveLength(0);
  const accepted = await post({ _csrf: codeCsrf("fixture-session", codeId), value: "one" });
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("X-Code-Page")).toBe("tree");
  expect(page.calls[0]?.request.body).toBe("value=one");
});
