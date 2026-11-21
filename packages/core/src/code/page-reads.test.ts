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

/** One provider "pulse" with a base type read by base.read; sql.run is no reader. */
function provider(answer: (id: string) => "ok" | "FORBIDDEN" | "NOT_FOUND" | "UNAVAILABLE", noPublicRoutes = ["pulse.base"]) {
  const asked: { capabilityId: string; id: string; authority: unknown }[] = [];
  const facts = spyOn(capabilities, "getCapabilityCodeReadFacts").mockImplementation(async (appId) =>
    appId === "pulse" ? { readers: { "pulse.base.read": "pulse.base" }, typeReaders: { "pulse.base": "base.read" }, noPublicRoutes } : null,
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
  expect(await check([{ kind: "reader", capability: "pulse.sql.run", id: "x" }], { public: false })).toBe("deliver");
  expect(asked).toEqual([]);
});

test("every target, ref and reader call is checked once with the type's reader under the visitor's authority", async () => {
  const asked = provider(() => "ok");
  const reads = [base("A"), base("A"), { kind: "reader", capability: "pulse.base.read", id: "B" } as const];
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
  await expect(check([{ kind: "target", ref: { type: "grids.base", id: "G" } }], { public: false })).rejects.toBeInstanceOf(
    CodeRouteReadsUnavailable,
  );
});

test("owner-data turns the check off on member routes, but never lets a no-public type onto a public route", async () => {
  const asked = provider(() => "FORBIDDEN");
  expect(await check([base("A")], { public: false, audience: "owner-data" })).toBe("deliver");
  expect(asked).toEqual([]);
  expect(await check([base("A")], { public: true, audience: "owner-data" }, null)).toBe("forbidden");
  provider(() => "FORBIDDEN", []);
  expect(await check([base("A")], { public: true, audience: "owner-data" }, null)).toBe("deliver");
  // Without owner-data, a public route has no visitor who could read anything.
  expect(await check([base("A")], { public: true }, null)).toBe("forbidden");
});

test("a member route without a visitor authority is refused", async () => {
  provider(() => "ok");
  expect(await check([base("A")], { public: false }, null)).toBe("forbidden");
});
