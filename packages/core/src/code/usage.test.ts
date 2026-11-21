import { afterEach, expect, spyOn, test } from "bun:test";
import * as capabilities from "@k2b/cloud/capabilities/server";
import { auth, type RequestAuthority } from "@k2b/cloud/server";
import { createCodeUsageRoutes } from "../api/code-usage";
import type { codePermission } from "./access";
import { CodeUsageForbidden, type CodeUsageRow, CodeUsageUnavailable, codeUsageInputFields, readCodeUsage } from "./usage";
import { CODE_USAGE_ITEMS_MAX } from "./usage-contracts";

const member = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const authority = (overrides: Partial<{ credentialKind: string; profile: string }> = {}) =>
  ({
    actor: {
      kind: "user",
      user: { id: member, uid: "member", displayName: "Member", roles: ["user"], profile: overrides.profile ?? "user" },
    },
    accessSubject: { type: "user", userId: member },
    credentialKind: overrides.credentialKind ?? "session",
    scopes: [],
  }) as unknown as RequestAuthority;
const now = new Date("2026-11-21T12:00:00.000Z");
const base = { type: "pulse.base", id: "Base01" };
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const hashes = { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) };
const manifest = (entrypoints: unknown[]) => ({
  version: 1,
  entry: "code.ts",
  entrypoints,
  ai: false,
  policyRows: ["read"],
  permissions: [],
  hashes,
});
const pageManifest = manifest([
  { kind: "route", entrypoint: "route:GET:/", file: "code.ts", line: 1, cron: null, route: { method: "GET", path: "/", public: false } },
]);
const automationManifest = manifest([{ kind: "manual", entrypoint: "manual", file: "code.ts", line: 1, cron: null }]);
const row = (id: string, at: string, rowManifest: unknown = automationManifest, ownerId = other): CodeUsageRow => ({
  id,
  owner_kind: "person",
  owner_user_id: ownerId,
  owner_type: null,
  owner_id: null,
  owner_app_id: null,
  title: `Title ${id}`,
  service_account_id: null,
  state: "active",
  active_version_id: "33333333-3333-4333-8333-333333333333",
  created_by: ownerId,
  created_at: new Date("2026-11-01T00:00:00.000Z"),
  manifest: rowManifest,
  owner_name: "Owner Person",
  last_called_at: new Date(at),
});

/** Pulse with a base type read by base.read; sql.run names its base in `baseId`. */
function provider(answer: "ok" | "FORBIDDEN" | "NOT_FOUND" | "UNAVAILABLE" = "ok", facts = true) {
  const asked: { capabilityId: string; id: string; authority: unknown }[] = [];
  spy(
    spyOn(capabilities, "getCapabilityCodeReadFacts").mockImplementation(async (appId) =>
      facts && appId === "pulse"
        ? {
            inputRefs: { "pulse.base.read": { id: "pulse.base" }, "pulse.sql.run": { baseId: "pulse.base", sourceId: "pulse.source" } },
            typeReaders: { "pulse.base": "base.read" },
            publicRoutes: false,
          }
        : null,
    ),
  );
  spy(
    spyOn(capabilities, "invokeCapabilityWithDataSchema").mockImplementation((async (
      body: { capabilityId: string; input: { id: string } },
      _schema: unknown,
      options: { authority: unknown },
    ) => {
      asked.push({ capabilityId: body.capabilityId, id: body.input.id, authority: options.authority });
      if (answer === "ok") return { ok: true, data: { data: { view: { title: "Base", permission: "read" } } } };
      return { ok: false, error: { code: answer, message: answer, status: answer === "UNAVAILABLE" ? 503 : 403 } };
    }) as unknown as typeof capabilities.invokeCapabilityWithDataSchema),
  );
  return asked;
}
const spy = (value: { mockRestore(): void }) => restores.push(() => value.mockRestore());

test("only input fields that name the asked type match: the type reader's id and declared inputRefs", () => {
  expect(
    codeUsageInputFields(
      { "pulse.base.read": { id: "pulse.base" }, "pulse.sql.run": { baseId: "pulse.base", sourceId: "pulse.source" } },
      "pulse.base",
    ),
  ).toEqual([
    { capability: "pulse.base.read", field: "id" },
    { capability: "pulse.sql.run", field: "baseId" },
  ]);
  expect(codeUsageInputFields({ "pulse.source.read": { id: "pulse.source" } }, "pulse.base")).toEqual([]);
});

test("the resource is checked with its reader as the person before any call is read, with the matching fields and window", async () => {
  const asked = provider("ok");
  const who = authority();
  const finds: unknown[] = [];
  const result = await readCodeUsage(
    { ref: base, now },
    { authority: who, locale: "en" },
    {
      find: async (input) => {
        finds.push(input);
        return [];
      },
    },
  );
  expect(asked).toEqual([{ capabilityId: "base.read", id: "Base01", authority: who }]);
  expect(finds).toEqual([
    {
      ref: base,
      fields: [
        { capability: "pulse.base.read", field: "id" },
        { capability: "pulse.sql.run", field: "baseId" },
      ],
      since: new Date("2026-10-22T12:00:00.000Z"),
    },
  ]);
  expect(result).toEqual({ items: [], others: 0, since: "2026-10-22T12:00:00.000Z" });
});

test("a refused or missing resource is forbidden and an unanswered reader is unavailable; neither reads calls", async () => {
  const find = async () => {
    throw new Error("calls must not be read");
  };
  for (const answer of ["FORBIDDEN", "NOT_FOUND"] as const) {
    provider(answer);
    await expect(readCodeUsage({ ref: base, now }, { authority: authority() }, { find })).rejects.toBeInstanceOf(CodeUsageForbidden);
    for (const restore of restores.splice(0)) restore();
  }
  provider("UNAVAILABLE");
  await expect(readCodeUsage({ ref: base, now }, { authority: authority() }, { find })).rejects.toBeInstanceOf(CodeUsageUnavailable);
  for (const restore of restores.splice(0)) restore();
  // A type without a reader cannot be checked, so nobody may ask about it; an unknown app is an unanswered registry.
  provider("ok");
  await expect(readCodeUsage({ ref: { type: "pulse.secret", id: "x" }, now }, { authority: authority() }, { find })).rejects.toBeInstanceOf(
    CodeUsageForbidden,
  );
  await expect(readCodeUsage({ ref: { type: "grids.table", id: "x" }, now }, { authority: authority() }, { find })).rejects.toBeInstanceOf(
    CodeUsageUnavailable,
  );
});

test("guests, API keys and OAuth tokens may not ask, even for a resource they could read", async () => {
  const asked = provider("ok");
  const find = async () => [];
  for (const who of [authority({ profile: "guest" }), authority({ credentialKind: "api_key" }), authority({ credentialKind: "oauth" })])
    await expect(readCodeUsage({ ref: base, now }, { authority: who }, { find })).rejects.toBeInstanceOf(CodeUsageForbidden);
  expect(asked).toEqual([]);
});

test("F4: only openable Codes are named, newest first; the others are only counted", async () => {
  provider("ok");
  const rows = [
    row("c_page", "2026-11-21T11:00:00.000Z", pageManifest),
    row("c_hidden", "2026-11-20T11:00:00.000Z"),
    row("c_auto", "2026-11-19T11:00:00.000Z"),
  ];
  const checked: string[] = [];
  const permission = (async (code: { id: string }) => {
    checked.push(code.id);
    return code.id === "c_hidden" ? null : "reader";
  }) as unknown as typeof codePermission;
  const result = await readCodeUsage({ ref: base, now }, { authority: authority(), locale: "en" }, { find: async () => rows, permission });
  expect(checked.sort()).toEqual(["c_auto", "c_hidden", "c_page"]);
  expect(result.items).toEqual([
    {
      codeId: "c_page",
      title: "Title c_page",
      kind: "page",
      owner: "Owner Person",
      lastCalledAt: "2026-11-21T11:00:00.000Z",
      href: "/code/c_page/",
    },
    {
      codeId: "c_auto",
      title: "Title c_auto",
      kind: "automation",
      owner: "Owner Person",
      lastCalledAt: "2026-11-19T11:00:00.000Z",
      href: "/app/assistant/code/c_auto",
    },
  ]);
  expect(result.others).toBe(1);
  expect(JSON.stringify(result)).not.toContain("c_hidden");
});

test("past the item limit the rest is counted without asking for more permissions", async () => {
  provider("ok");
  const rows = Array.from({ length: CODE_USAGE_ITEMS_MAX + 30 }, (_, index) =>
    row(`c_${String(index).padStart(3, "0")}`, new Date(now.getTime() - index * 60_000).toISOString()),
  );
  let checks = 0;
  const permission = (async () => {
    checks++;
    return "reader";
  }) as unknown as typeof codePermission;
  const result = await readCodeUsage({ ref: base, now }, { authority: authority() }, { find: async () => rows, permission });
  expect(result.items).toHaveLength(CODE_USAGE_ITEMS_MAX);
  expect(result.items[0]?.codeId).toBe("c_000");
  expect(result.others).toBe(30);
  // Permissions are checked in groups of eight, so at most one group beyond the limit.
  expect(checks).toBeLessThanOrEqual(CODE_USAGE_ITEMS_MAX + 8);
});

test("the route validates its query, answers no-store and maps refusals to their codes", async () => {
  spy(spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next()));
  spy(spyOn(auth, "getAuthority").mockReturnValue(authority()));
  const responses: Record<string, () => Promise<never> | Promise<{ items: []; others: number; since: string }>> = {
    ok: async () => ({ items: [], others: 2, since: "2026-10-22T12:00:00.000Z" }),
    forbidden: async () => {
      throw new CodeUsageForbidden("no");
    },
    unavailable: async () => {
      throw new CodeUsageUnavailable("down");
    },
  };
  let answer = "ok";
  const asked: unknown[] = [];
  const routes = createCodeUsageRoutes({
    read: async (input) => {
      asked.push(input);
      return responses[answer]!();
    },
  });
  const ok = await routes.request("/?type=pulse.base&id=Base01");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toContain("no-store");
  expect(await ok.json()).toEqual({ data: { items: [], others: 2, since: "2026-10-22T12:00:00.000Z" } });
  expect(asked).toEqual([{ ref: base }]);
  answer = "forbidden";
  expect(await (await routes.request("/?type=pulse.base&id=Base01")).json()).toEqual({ code: "code_usage_forbidden" });
  answer = "unavailable";
  expect((await routes.request("/?type=pulse.base&id=Base01")).status).toBe(503);
  for (const bad of ["/?type=pulse.base", "/?type=Pulse&id=x", `/?type=pulse.base&id=${"x".repeat(513)}`, "/?type=pulse.base&id=x&extra=1"])
    expect((await routes.request(bad)).status).toBe(400);
  expect(asked).toHaveLength(3);
});
