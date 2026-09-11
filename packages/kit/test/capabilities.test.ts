import { expect, test, spyOn, afterEach, mock } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { kitCapabilities } from "../src/capabilities";
import { projects, ProjectError } from "../src/service";
import { CapabilityActionReviewSchema } from "@k2b/cloud/contracts";
import { database, DatabaseError } from "../src/service/database";
import { testIdentity } from "./identity";

const context = testIdentity("00000000-0000-4000-8000-000000000001");
afterEach(() => mock.restore());
test("capability manifest exposes app lifecycle and source authoring without deletion or SDK tools", () => {
  const manifest = compileCapabilityManifest("kit", kitCapabilities);
  expect(JSON.stringify(manifest)).toContain("source.apply");
  expect(Object.keys(kitCapabilities.actions)).toEqual(["app.create", "app.update", "database.write", "source.apply"]);
  expect(Object.keys(kitCapabilities.queries)).toEqual([
    "database.status",
    "database.read",
    "database.sql",
    "app.search",
    "app.read",
    "source.read",
    "source.validate",
  ]);
  expect(kitCapabilities.actions[("database.write", "source.apply")].destructive).toBe(true);
});
test("capability validation and apply share service revision guards and localized failures", async () => {
  const change = spyOn(projects, "changeSource").mockRejectedValue(new ProjectError(409, "REVISION_CONFLICT"));
  const input = { id: "abc123", expectedRevision: 2, upsert: [{ path: "helper.js", content: "" }], delete: [], edits: [] };
  const result = await kitCapabilities.actions[("database.write", "source.apply")].run(input, context);
  expect(result).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT", status: 409 } });
  expect(JSON.stringify(result)).toContain("andernorts");
  expect(change.mock.calls[0]?.[3]).toBe(true);
  await kitCapabilities.queries["source.validate"].run(input, context);
  expect(change.mock.calls[1]?.[3]).toBeUndefined();
});

test("action review keeps all affected paths within platform presentation limits", async () => {
  const input = {
    id: "abc123",
    expectedRevision: 1,
    upsert: [],
    edits: [],
    delete: Array.from({ length: 64 }, (_, i) => `${"a".repeat(180)}/${i}.js`),
  };
  spyOn(projects, "changeSource").mockResolvedValue({ id: input.id, revision: 1, entries: [], valid: true });
  spyOn(projects, "manifest").mockResolvedValue({
    id: input.id,
    name: "Test",
    description: "",
    persistenceEnabled: true,
    revision: 1,
    sdkVersion: 1,
    updatedAt: new Date().toISOString(),
    permission: "admin",
    files: [],
    entries: [],
  });
  const review = await kitCapabilities.actions[("database.write", "source.apply")].review(input, context);
  expect(review.ok).toBe(true);
  if (!review.ok) throw Error("Review failed");
  const parsed = CapabilityActionReviewSchema.parse(review.data);
  for (const path of input.delete) expect(parsed.details?.some((detail) => detail.value.includes(path))).toBe(true);
});

test("SQL is a dedicated read capability with bound parameters and generation", async () => {
  const input = { id: "abc123", generation: 3, sql: "SELECT title FROM todos WHERE done = ? LIMIT 10", params: [false] };
  const call = spyOn(database, "call").mockResolvedValue({ data: [{ title: "Task" }], columns: ["title"] });
  const parsed = kitCapabilities.queries["database.sql"].input.parse(input);
  const response = await kitCapabilities.queries["database.sql"].run(parsed, context);
  expect(response).toMatchObject({ ok: true, data: { data: { columns: ["title"], data: [{ title: "Task" }] } } });
  expect(call.mock.calls[0]).toEqual(["abc123", 3, { operation: "query", sql: input.sql, params: [false] }, context]);
  expect(kitCapabilities.queries["database.read"].input.safeParse({ id: input.id, generation: 3, request: { operation: "query", sql: input.sql } }).success).toBe(false);
  expect(kitCapabilities.queries["database.read"].input.safeParse({ id: input.id, generation: 3, request: { operation: "rows.delete", table: "todos", id: 1 } }).success).toBe(false);
  expect(kitCapabilities.actions["database.write"].input.safeParse({ id: input.id, generation: 3, request: { operation: "query", sql: input.sql } }).success).toBe(false);
  expect(kitCapabilities.queries["database.sql"].input.safeParse({ ...input, generation: 0 }).success).toBe(false);
  expect(kitCapabilities.queries["database.sql"].input.safeParse({ ...input, sql: " " }).success).toBe(false);
  call.mockRejectedValue(new DatabaseError("query_failed", 400));
  const failed = await kitCapabilities.queries["database.sql"].run(parsed, context);
  expect(failed).toMatchObject({ ok: false, error: { code: "query_failed" } });
  expect(JSON.stringify(failed)).toContain("Leseabfrage");
  expect(JSON.stringify(failed)).not.toContain("Schreibvorgang");
  call.mockRejectedValue(new DatabaseError("DB_STALE", 409));
  expect(await kitCapabilities.queries["database.sql"].run(parsed, context)).toMatchObject({ ok: false, error: { code: "DB_STALE" } });
});

test("app lifecycle has bounded rememberable approvals without delete or permission inputs", async () => {
  const create = kitCapabilities.actions["app.create"];
  const update = kitCapabilities.actions["app.update"];
  expect(create.input.parse({ name: "Books" })).toEqual({ name: "Books", description: "", databaseEnabled: false });
  expect(create.input.safeParse({ name: "Books", files: [] }).success).toBe(false);
  expect(update.input.safeParse({ id: "abc123", expectedRevision: 1 }).success).toBe(false);
  expect(update.input.safeParse({ id: "abc123", expectedRevision: 1, reset: true }).success).toBe(false);
  const review = await create.review({ name: "Books", description: "", databaseEnabled: true }, context);
  expect(review).toMatchObject({ ok: true, data: { approvalScope: "apps:create" } });
  expect(create.approval).toBe("rememberable");
  expect(update.approval).toBe("rememberable");
  expect(kitCapabilities.actions["source.apply"].destructive).toBe(true);
  const change = spyOn(projects, "metadata").mockResolvedValue({ id: "abc123", name: "Books", description: "", persistenceEnabled: false, revision: 2, sdkVersion: 1, updatedAt: "", permission: "admin", entries: [], files: [] });
  spyOn(database, "status").mockResolvedValue({ enabled: false, globallyEnabled: true, provisioned: true, generation: 1, status: "disabled", canAdmin: true, error: null, overview: null, tables: null });
  expect(await update.run({ id: "abc123", expectedRevision: 1, databaseEnabled: false }, context)).toMatchObject({ ok: true, data: { data: { id: "abc123", revision: 2, database: { enabled: false } } } });
  expect(change.mock.calls[0]).toEqual(["abc123", { expectedRevision: 1, databaseEnabled: false }, context]);
});
