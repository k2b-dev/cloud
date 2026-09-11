import { expect, test } from "bun:test";
import { RailAdminSchema, type RailAdminState } from "../contracts/rail-admin";
import { createRailShortcutsService, RailAdminError } from "../services/rail-shortcuts";
import { buildProjectedUser } from "../services/session/user";
import { createAdminRailRoutes } from "./admin-rail";

const administrator = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
test("admin service checks cannot be bypassed by skipping the route role guard", async () => {
  const routes = createAdminRailRoutes(createRailShortcutsService(), async (_c, next) => next());
  expect((await routes.request("/")).status).toBe(403);
  expect((await routes.request("/cache", { method: "DELETE" })).status).toBe(403);
});
test("admin API validates audiences and reports conflicts without losing the typed canonical response", async () => {
  let invalidations = 0;
  let stored: RailAdminState = { revision: 0, entries: [] };
  const routes = createAdminRailRoutes(
    {
      invalidateCache: async (actor) => {
        expect(actor).toEqual(administrator);
        invalidations++;
      },
      list: async () => stored,
      save: async (actor, value) => {
        expect(actor).toEqual(administrator);
        if (value.revision !== stored.revision) throw new RailAdminError(409, "Conflict");
        stored = {
          ...value,
          entries: value.entries.map((entry) => ({
            ...entry,
            access: entry.access.map((access) => ({ ...access, id: crypto.randomUUID(), createdAt: new Date().toISOString() })),
          })),
          revision: value.revision + 1,
        };
        return stored;
      },
      forUser: async () => [],
    },
    async (c, next) => {
      c.set("user", administrator);
      await next();
    },
  );
  const cleared = await routes.request("/cache", { method: "DELETE" });
  expect(cleared.status).toBe(204);
  expect(cleared.headers.get("cache-control")).toBe("no-store");
  expect(invalidations).toBe(1);
  const put = (body: unknown) =>
    routes.request("/", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await put(stored);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(RailAdminSchema.parse(await response.json()).revision).toBe(1);
  expect((await put({ revision: 0, entries: [] })).status).toBe(409);
  const entry = {
    shortcut: { id: "one", kind: "app", appId: "mail" },
    access: [{ id: crypto.randomUUID(), principal: { type: "public" }, permission: "read", createdAt: "" }],
  };
  expect((await put({ ...stored, entries: [entry] })).status).toBe(400);
  expect(
    (
      await put({
        ...stored,
        entries: [{ ...entry, access: [{ ...entry.access[0], principal: { type: "authenticated" }, permission: "admin" }] }],
      })
    ).status,
  ).toBe(400);
  expect((await put({ padding: "x".repeat(17000) })).status).toBe(413);
});
