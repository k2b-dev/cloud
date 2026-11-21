import { afterEach, expect, spyOn, test } from "bun:test";
import * as capabilities from "@k2b/cloud/capabilities/server";
import type { RequestAuthority } from "@k2b/cloud/server";
import { CodeRouteReadsUnavailable, checkCodeRouteReads } from "./page-reads";
import type { CodeRouteRead } from "./requests";

const visitor = {
  actor: { kind: "user", user: { id: "visitor" } },
  accessSubject: { type: "user", userId: "visitor" },
  credentialKind: "session",
  scopes: [],
} as unknown as RequestAuthority;
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** One provider "pulse" with a base type read by base.read; sql.run names its base in `baseId` (inputRefs). */
function provider(
  answer: (id: string) => "ok" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION_FAILED" | "UNAVAILABLE",
  pulseOnPublicRoutes = false,
) {
  const asked: { capabilityId: string; id: string; authority: unknown }[] = [];
  type Facts = Awaited<ReturnType<typeof capabilities.getCapabilityCodeReadFacts>>;
  const facts = spyOn(capabilities, "getCapabilityCodeReadFacts").mockImplementation(
    async (appId): Promise<Facts> =>
      appId === "pulse"
        ? {
            inputRefs: { "pulse.base.read": { id: "pulse.base" }, "pulse.sql.run": { baseId: "pulse.base" } },
            typeReaders: { "pulse.base": "base.read" },
            publicRoutes: pulseOnPublicRoutes,
          }
        : appId === "grids"
          ? { inputRefs: {}, typeReaders: {}, publicRoutes: true }
          : null,
  );
  const invoke = spyOn(capabilities, "invokeCapabilityWithDataSchema").mockImplementation((async (
    body: { capabilityId: string; input: { id: string } },
    _schema: unknown,
    options: { authority: unknown },
  ) => {
    asked.push({ capabilityId: body.capabilityId, id: body.input.id, authority: options.authority });
    const result = answer(body.input.id);
    if (result === "ok") return { ok: true, data: { data: { view: { title: "Base", permission: "read" } } } };
    return { ok: false, error: { code: result, message: result, status: result === "UNAVAILABLE" ? 503 : 403 } };
  }) as unknown as typeof capabilities.invokeCapabilityWithDataSchema);
  restores.push(
    () => facts.mockRestore(),
    () => invoke.mockRestore(),
  );
  return asked;
}
const check = (reads: CodeRouteRead[], route: { public: boolean; audience?: "owner-data" }, who: RequestAuthority | null = visitor) =>
  checkCodeRouteReads({ reads, route, visitor: who, locale: "en", signal: new AbortController().signal });
const base = (id: string): CodeRouteRead => ({ kind: "target", ref: { type: "pulse.base", id } });

test("a route that read nothing is delivered without asking any provider", async () => {
  const asked = provider(() => "FORBIDDEN");
  expect(await check([], { public: false })).toBe("deliver");
  expect(await check([{ kind: "input", capability: "pulse.base.list", fields: { query: "x", id: "y" } }], { public: false })).toBe(
    "deliver",
  );
  expect(asked).toEqual([]);
});

test("every target, ref and reader call is checked once with the type's reader under the visitor's authority", async () => {
  const asked = provider(() => "ok");
  const reads = [base("A"), base("A"), { kind: "input", capability: "pulse.base.read", fields: { id: "B" } } as const];
  expect(await check(reads, { public: false })).toBe("deliver");
  expect(asked.map(({ capabilityId, id }) => [capabilityId, id]).sort()).toEqual([
    ["base.read", "A"],
    ["base.read", "B"],
  ]);
  expect(asked.every((entry) => entry.authority === visitor)).toBe(true);
});

test("one unreadable resource refuses the whole answer; a missing resource refuses too", async () => {
  provider((id) => (id === "secret" ? "FORBIDDEN" : "ok"));
  expect(await check([base("open"), base("secret")], { public: false })).toBe("forbidden");
  provider((id) => (id === "gone" ? "NOT_FOUND" : "ok"));
  expect(await check([base("gone")], { public: false })).toBe("forbidden");
});

test("a resource whose type has no reader is never delivered (fail closed)", async () => {
  provider(() => "ok");
  expect(await check([{ kind: "target", ref: { type: "pulse.dashboard", id: "D" } }], { public: false })).toBe("forbidden");
});

test("an unavailable reader or registry is an error, never a delivery", async () => {
  provider(() => "UNAVAILABLE");
  await expect(check([base("A")], { public: false })).rejects.toBeInstanceOf(CodeRouteReadsUnavailable);
  provider(() => "ok");
  await expect(check([{ kind: "target", ref: { type: "unknown.thing", id: "G" } }], { public: false })).rejects.toBeInstanceOf(
    CodeRouteReadsUnavailable,
  );
});

test("owner-data turns the check off on member routes without asking any reader", async () => {
  const asked = provider(() => "FORBIDDEN");
  expect(await check([base("A")], { public: false, audience: "owner-data" })).toBe("deliver");
  expect(asked).toEqual([]);
});

test("a public route needs owner-data for any app Query, and never calls an app that keeps its data off public routes", async () => {
  const asked = provider(() => "ok");
  const pulseList: CodeRouteRead = { kind: "query", capability: "pulse.base.list" };
  const gridsList: CodeRouteRead = { kind: "query", capability: "grids.table.list" };
  // Lists and searches carry no resource, so the query itself decides on a public route.
  expect(await check([pulseList], { public: true, audience: "owner-data" }, null)).toBe("forbidden");
  expect(await check([gridsList], { public: true }, null)).toBe("forbidden");
  expect(await check([gridsList], { public: true, audience: "owner-data" }, null)).toBe("deliver");
  // The Code's own files are no app data (its database is: see below).
  expect(await check([{ kind: "query", capability: "core.code.file.read" }], { public: true }, null)).toBe("deliver");
  provider(() => "ok", true);
  expect(await check([pulseList, base("A")], { public: true, audience: "owner-data" }, null)).toBe("deliver");
  expect(asked).toEqual([]);
});

test("a member route without a visitor authority is refused", async () => {
  provider(() => "ok");
  expect(await check([base("A")], { public: false }, null)).toBe("forbidden");
});

test("the app-wide form names its base in the input: sql.run({ baseId }) is checked like the target form", async () => {
  const asked = provider((id) => (id === "Secret" ? "FORBIDDEN" : "ok"));
  const old = (baseId: string): CodeRouteRead => ({ kind: "input", capability: "pulse.sql.run", fields: { baseId, sql: "SELECT 1" } });
  expect(await check([old("Open01")], { public: false })).toBe("deliver");
  expect(await check([old("Secret")], { public: false })).toBe("forbidden");
  expect(asked.map(({ capabilityId, id }) => [capabilityId, id])).toEqual([
    ["base.read", "Open01"],
    ["base.read", "Secret"],
  ]);
  // A reader that refuses the ID as input (for example a UUID where it takes a short ID) never delivers.
  provider(() => "VALIDATION_FAILED");
  expect(await check([old("not-a-short-id")], { public: false })).toBe("forbidden");
});

test("AI reads no resource by itself on a public route, but a resource it is given still needs owner-data", async () => {
  provider(() => "ok");
  const ai: CodeRouteRead = { kind: "query", capability: "core.ai.generate" };
  expect(await check([ai], { public: true }, null)).toBe("deliver");
  expect(await check([ai, base("A")], { public: true }, null)).toBe("forbidden");
});

test("a public route that reads the Code's own database needs owner-data: it outlives versions and may hold app data", async () => {
  provider(() => "ok");
  const db: CodeRouteRead = { kind: "query", capability: "db.query" };
  expect(await check([db], { public: true }, null)).toBe("forbidden");
  expect(await check([db], { public: true, audience: "owner-data" }, null)).toBe("deliver");
  expect(await check([{ kind: "query", capability: "core.code.file.read" }], { public: true }, null)).toBe("deliver");
});

test("a named input field that is empty or longer than any resource ID is never delivered (fail closed)", async () => {
  const asked = provider(() => "ok");
  const old = (baseId: string): CodeRouteRead => ({ kind: "input", capability: "pulse.sql.run", fields: { baseId } });
  expect(await check([old("")], { public: false })).toBe("forbidden");
  expect(await check([old("b".repeat(513))], { public: false })).toBe("forbidden");
  expect(asked).toEqual([]);
});
