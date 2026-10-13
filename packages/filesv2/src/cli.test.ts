import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { hc } from "hono/client";
import filesCli from "./cli";
import { withEntryPermalink, withEntryPermalinks, withEntryResultPermalink } from "./cli-address";
import type { AdminResult, InventoryEntry } from "./contracts";
import { entryRefId } from "./resource-ref";

const entry = (name: string, displayName: string | null): InventoryEntry => ({
  identityId: displayName === null ? null : `${name}-id`,
  name,
  displayName,
  path: `users/${name}`,
  kind: "users",
  area: "cloud",
  status: "existing",
  reason: null,
  baseId: null,
  operationId: null,
  uid: null,
  gid: null,
  actions: { create: false, adopt: false, archive: false, browse: true, delete: false, retire: false },
});

const inventory = (output: "text" | "json") => {
  const result = {
    items: [entry("qdt", "Quinn Doe"), entry("ghost", null)],
    next: null,
    issue: null,
    root: null,
  } satisfies Pick<AdminResult, "items" | "next" | "issue" | "root">;
  const requests: string[] = [];
  const tables: { labels: (string | undefined)[]; cells: unknown[][] }[] = [];
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args: ["admin", "inventory"],
    flags: {},
    options: { profile: "test", server: "http://cloud.test", token: "token", output },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: ((basePath: string) =>
      hc(`http://cloud.test${basePath}`, {
        fetch: async (input: Parameters<typeof fetch>[0]) => {
          requests.push(String(input));
          return Response.json(result);
        },
      })) as CloudCliContext["createApiClient"],
    fetch: async () => {
      throw new Error("Unexpected fetch");
    },
    readJson: async (response) => response.json(),
    print: (value = "") => void lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => void lines.push(value),
    json: (value) => void lines.push(JSON.stringify(value)),
    jsonLine: (value) => void lines.push(JSON.stringify(value)),
    table: (rows, columns) =>
      void tables.push({
        labels: columns.map((column) => column.label),
        cells: rows.map((row) => columns.map((column) => (column.value ? column.value(row) : row[String(column.key)]))),
      }),
  };
  return { ctx, requests, tables, lines };
};

test("admin inventory shows display names and marks directories without an account", async () => {
  const { ctx, requests, tables } = inventory("text");
  await filesCli.run(ctx);
  expect(requests).toHaveLength(1);
  const [table] = tables;
  const index = table!.labels.indexOf("Display name");
  expect(index).toBeGreaterThan(-1);
  expect(table!.cells.map((row) => row[index])).toEqual(["Quinn Doe", "unknown account"]);
});

test("admin inventory JSON keeps displayName null for unknown owners", async () => {
  const { ctx, lines } = inventory("json");
  await filesCli.run(ctx);
  const value: Pick<AdminResult, "items"> = JSON.parse(lines[0]!);
  expect(value.items.map((item) => item.displayName)).toEqual(["Quinn Doe", null]);
});

test("resource URLs use Files reader IDs for stable, persisted, and inline entries", () => {
  const { ctx, requests } = inventory("json");
  const baseId = "cloud:users:11111111-1111-4111-8111-111111111111";
  const base = {
    id: baseId,
    name: "Home",
    area: "cloud" as const,
    kind: "users" as const,
    status: "existing" as const,
    reason: null,
    indexEnabled: true,
    versioningEnabled: true,
  };
  const entry = { name: "a.txt", path: "Docs/a.txt", directory: false, size: 1, modified: "2026-10-01" };
  const stableId = `n:${baseId}:22222222-2222-4222-8222-222222222222`;
  for (const id of [stableId, `p:${"a".repeat(64)}`, entryRefId(baseId, entry.path)!]) {
    const result = withEntryResultPermalink(ctx, { base, entry, resourceId: id });
    expect(result.entry).toEqual({ ...entry, permalink: `http://cloud.test/open/filesv2.entry/${encodeURIComponent(id)}` });
  }
  const inline = withEntryResultPermalink(ctx, { base, entry });
  expect(inline.entry.permalink).toBe(`http://cloud.test/open/filesv2.entry/${entryRefId(baseId, entry.path)}`);
  expect(entry).not.toHaveProperty("permalink");
  expect(requests).toHaveLength(0);
});

test("resource URLs use locally known IDs and leave unknown entries unchanged without fetching", () => {
  const baseId = "cloud:users:11111111-1111-4111-8111-111111111111";
  const base = {
    id: baseId,
    name: "Home",
    area: "cloud" as const,
    kind: "users" as const,
    status: "existing" as const,
    reason: null,
    indexEnabled: true,
    versioningEnabled: true,
  };
  const entry = { name: "a.txt", path: `${"folder/".repeat(100)}a.txt`, directory: false, size: 1, modified: "2026-10-01" };
  const resourceId = `p:${"b".repeat(64)}`;
  const { ctx, requests } = inventory("json");
  expect(entryRefId(baseId, entry.path)).toBeNull();
  expect(withEntryPermalink(ctx, baseId, entry)).toBe(entry);
  expect(withEntryResultPermalink(ctx, { base, entry }).entry).toBe(entry);
  expect(withEntryPermalinks(ctx, baseId, [entry])).toEqual([entry]);
  const known = { ...entry, resourceId };
  expect(withEntryPermalink(ctx, baseId, known).permalink).toBe(`http://cloud.test/open/filesv2.entry/${encodeURIComponent(resourceId)}`);
  expect(withEntryPermalink(ctx, baseId, known, "explicit-id").permalink).toBe("http://cloud.test/open/filesv2.entry/explicit-id");
  expect(withEntryResultPermalink(ctx, { base, entry, resourceId }).entry.permalink).toBe(
    `http://cloud.test/open/filesv2.entry/${encodeURIComponent(resourceId)}`,
  );
  expect(requests).toHaveLength(0);
  const text = inventory("text");
  expect(withEntryPermalinks(text.ctx, baseId, [known])).toEqual([known]);
  expect(text.requests).toHaveLength(0);
});
