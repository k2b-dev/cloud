import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { type CodeCheckedVersionManifest, UserSchema } from "@k2b/cloud/contracts";
import * as server from "@k2b/cloud/server";
import { Hono } from "hono";
import { stubConnections } from "../../../../scripts/fixtures/platform";
import { createCodePageRoutes } from "../api/code-pages";
import { CODE_PAGE_LABEL_BUDGET_MS, codePageLabel } from "./page-provenance";
import { codePageProvenanceRoutes } from "./page-provenance-contracts";
import * as reports from "./page-reports";
import { CodeRequestError, type CodeRequestOwner } from "./requests";
import { checkCodePageVersionValue, codePageVersionValue } from "./route-security";

const codeId = "c_label1";
const versionId = "33333333-3333-4333-8333-333333333333";
const person = UserSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mia",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
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
const guest = { ...person, profile: "guest" as const, roles: [] };
const member = {
  actor: { kind: "user" as const, user: person },
  accessSubject: { type: "user" as const, userId: person.id },
  credentialKind: "session" as const,
};
const lea: CodeRequestOwner = { kind: "person", userId: "22222222-2222-4222-8222-222222222222", name: "Lea Muster" };

let secret: ReturnType<typeof stubConnections> | undefined;
beforeAll(() => {
  secret = stubConnections();
});
afterAll(() => secret?.mockRestore());
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
});

test("the pill names the owner to members only: a person by name, an app by name, a resource only by its type", async () => {
  const title = spyOn(server, "codeOwnerKindTitle").mockImplementation(async (owner) => (owner.kind === "app" ? "Mail" : "Postfach"));
  spies.push(title);
  const mailbox: CodeRequestOwner = { kind: "resource", ref: { type: "mail.mailbox", id: "einkauf" } };
  expect(await codePageLabel(lea, member, "de")).toEqual({ kind: "person", name: "Lea Muster" });
  expect(await codePageLabel({ kind: "app", appId: "mail" }, member, "de")).toEqual({ kind: "app", name: "Mail" });
  expect(await codePageLabel(mailbox, member, "de")).toEqual({ kind: "resource", type: "Postfach" });
  expect(title).toHaveBeenCalledWith(mailbox, "de");
  // Visitors without an account, signed-in guests and workload credentials see a page someone built.
  for (const viewer of [
    {},
    { ...member, actor: { kind: "user" as const, user: guest } },
    { ...member, credentialKind: "api_key" as const },
  ]) {
    for (const owner of [lea, mailbox, { kind: "app" as const, appId: "mail" }])
      expect(await codePageLabel(owner, viewer, "de")).toEqual({ kind: "anonymous" });
  }
  // An owner the registry cannot tell, or a person without a name, is not guessed.
  title.mockResolvedValue(null);
  expect(await codePageLabel(mailbox, member, "de")).toEqual({ kind: "anonymous" });
  expect(await codePageLabel({ ...lea, name: null }, member, "de")).toEqual({ kind: "anonymous" });
});

test("a registry that does not answer leaves the pill anonymous within its budget instead of holding up the page", async () => {
  spies.push(spyOn(server, "codeOwnerKindTitle").mockImplementation(() => new Promise<string | null>(() => undefined)));
  const started = performance.now();
  expect(await codePageLabel({ kind: "app", appId: "mail" }, member, "de")).toEqual({ kind: "anonymous" });
  expect(performance.now() - started).toBeLessThan(CODE_PAGE_LABEL_BUDGET_MS + 500);
  const long = await codePageLabel({ ...lea, name: "L".repeat(300) }, member, "de");
  expect(long).toEqual({ kind: "person", name: "L".repeat(200) });
});

test("the version value is opaque, stable across requests, bound to Code and version, and checked exactly", () => {
  const value = codePageVersionValue(codeId, versionId);
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(value).not.toContain(versionId.slice(0, 8));
  expect(codePageVersionValue(codeId, versionId)).toBe(value);
  expect(codePageVersionValue(codeId, "44444444-4444-4444-8444-444444444444")).not.toBe(value);
  expect(codePageVersionValue("c_label2", versionId)).not.toBe(value);
  expect(checkCodePageVersionValue(codeId, versionId, value)).toBe(true);
  expect(checkCodePageVersionValue(codeId, "44444444-4444-4444-8444-444444444444", value)).toBe(false);
  for (const wrong of ["", "x".repeat(43), `${value}=`, value.slice(1), versionId])
    expect(checkCodePageVersionValue(codeId, versionId, wrong)).toBe(false);
  expect(codePageProvenanceRoutes.read.input.safeParse({ codeId, path: "/", version: value }).success).toBe(true);
});

const manifest = (routes: { path: string; public: boolean; method?: "GET" | "POST" | "ALL" }[]): CodeCheckedVersionManifest => ({
  version: 1,
  entry: "code.ts",
  entrypoints: routes.map((route) => ({
    kind: "route" as const,
    entrypoint: `route:${route.method ?? "GET"}:${route.path}`,
    route: { method: route.method ?? "GET", path: route.path, public: route.public },
    cron: null,
    file: "code.ts",
    line: 1,
  })),
  permissions: [],
  ai: false,
  policyRows: routes.some((route) => route.public) ? ["public_routes"] : [],
  hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
});
const pages = manifest([
  { path: "/", public: false },
  { path: "/open", public: true },
  { path: "/receive", public: false, method: "POST" },
]);

function routes(
  viewer?: { user: typeof person },
  version: () => Promise<{ versionId: string; manifest: CodeCheckedVersionManifest; owner: CodeRequestOwner }> = async () => ({
    versionId,
    manifest: pages,
    owner: lea,
  }),
) {
  const limited = new Set<string>();
  const checks: string[] = [];
  spies.push(
    spyOn(server, "ratelimit").mockImplementation(({ id }) => ({
      id,
      check: async (key: string) => {
        checks.push(`${id}:${key}`);
        return { limited: limited.has(id), remaining: 1, resetIn: 1 };
      },
      checkOrThrow: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
    })),
  );
  const router = new Hono<server.AuthContext>()
    .use("*", async (c, next) => {
      if (viewer) {
        c.set("actor", { kind: "user", user: viewer.user });
        c.set("accessSubject", { type: "user", userId: viewer.user.id });
        c.set("credentialKind", "session");
      }
      await next();
    })
    .route("/api/code/pages", createCodePageRoutes({ version }));
  const post = (path: "provenance" | "report", body: Record<string, unknown>) =>
    router.request(`/api/code/pages/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { post, limited, checks };
}
const current = () => codePageVersionValue(codeId, versionId);
const report = (path = "/") => ({
  codeId,
  path,
  version: current(),
  reason: null,
  text: "Fragt nach meinem Passwort.",
  key: crypto.randomUUID(),
});

test("the card admits like the page: missing and inaccessible Code answer alike, guests and visitors stay out of member pages", async () => {
  const missing = routes({ user: person }, async () => {
    throw new CodeRequestError("code_route_not_found", 404);
  });
  const gone = await missing.post("provenance", { codeId, path: "/", version: current() });
  const unknownPath = await routes({ user: person }).post("provenance", { codeId, path: "/elsewhere", version: current() });
  expect([gone.status, unknownPath.status]).toEqual([404, 404]);
  expect(await gone.json()).toEqual(await unknownPath.json());
  expect(await (await routes({ user: person }).post("provenance", { codeId, path: "/elsewhere", version: current() })).json()).toEqual({
    code: "code_route_not_found",
  });
  const visitor = await routes().post("provenance", { codeId, path: "/", version: current() });
  expect(visitor.status).toBe(401);
  expect(await visitor.json()).toEqual({ code: "code_sign_in_required" });
  const signedInGuest = await routes({ user: guest }).post("provenance", { codeId, path: "/", version: current() });
  expect(signedInGuest.status).toBe(403);
  expect(await signedInGuest.json()).toEqual({ code: "code_members_only" });
});

test("visitors of a public page, signed in as a guest or not, learn nothing; the budget is the page's under its own IDs", async () => {
  for (const viewer of [undefined, { user: guest }]) {
    const { post, checks } = routes(viewer);
    const response = await post("provenance", { codeId, path: "/open", version: current() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { viewer: "visitor", owner: null, automation: null, gives: "nothing", report: null } });
    expect(checks.every((check) => check.startsWith("code-page-label-public:"))).toBe(true);
    expect(checks.some((check) => check.endsWith(`code:${codeId}`))).toBe(true);
  }
  const busy = routes();
  busy.limited.add("code-page-label-public");
  const limited = await busy.post("provenance", { codeId, path: "/open", version: current() });
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ code: "code_request_rate_limit" });
});

test("a page delivered with another version answers code_page_changed, but only after the rights were checked", async () => {
  const stale = codePageVersionValue(codeId, "44444444-4444-4444-8444-444444444444");
  const changed = await routes().post("provenance", { codeId, path: "/open", version: stale });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ code: "code_page_changed" });
  // A member page asked by a visitor still says sign in, never that the page changed.
  expect((await routes().post("provenance", { codeId, path: "/", version: stale })).status).toBe(401);
  // The answer to a form sent without scripts has its own route; the card asks about it like the page.
  expect((await routes().post("provenance", { codeId, path: "/receive", version: stale })).status).toBe(401);
});

test("paths with a query, a fragment or another Code, and malformed input, are refused as bad input", async () => {
  for (const path of ["/open?x=1", "/open#top", "/code/c_other/", "/a/../open", "/a b"]) {
    const response = await routes().post("provenance", { codeId, path, version: current() });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("BAD_INPUT");
  }
  expect((await routes().post("provenance", { codeId, path: "/", version: "short" })).status).toBe(400);
});

test("only members report: visitors and guests get the same refusal on every page, before any Code is read", async () => {
  let asked = 0;
  const count = async () => {
    asked++;
    return { versionId, manifest: pages, owner: lea };
  };
  for (const viewer of [undefined, { user: guest }]) {
    for (const path of ["/open", "/"]) {
      const response = await routes(viewer, count).post("report", report(path));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "code_report_members_only" });
    }
  }
  expect(asked).toBe(0);
});

test("a member's report is filed once per key, bounded per person, and refused for a changed page", async () => {
  const filed: Parameters<typeof reports.fileCodePageReport>[0][] = [];
  spies.push(
    spyOn(reports, "fileCodePageReport").mockImplementation(async (input) => {
      filed.push(input);
      return { reportedAt: "2026-11-12T09:30:00.000Z" };
    }),
  );
  const { post, checks, limited } = routes({ user: person });
  const body = report("/");
  const response = await post("report", { ...body, reason: "security" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { reportedAt: "2026-11-12T09:30:00.000Z" } });
  expect(filed[0]).toMatchObject({ codeId, path: "/", reporterId: person.id, reason: "security", key: body.key });
  expect(checks).toContain(`code-page-label-member:user:${person.id}`);
  expect(checks).toContain(`code-page-reports:user:${person.id}`);
  limited.add("code-page-reports");
  const busy = await post("report", report("/"));
  expect(busy.status).toBe(429);
  expect(await busy.json()).toEqual({ code: "code_report_rate_limit" });
  limited.clear();
  const changed = await post("report", { ...report("/"), version: codePageVersionValue(codeId, "44444444-4444-4444-8444-444444444444") });
  expect(changed.status).toBe(409);
  expect(await changed.json()).toEqual({ code: "code_page_changed" });
  for (const text of ["", "   ", "x".repeat(2001)]) expect((await post("report", { ...report("/"), text })).status).toBe(400);
  expect((await post("report", { ...report("/"), reason: "spam" })).status).toBe(400);
  expect(filed).toHaveLength(1);
});
