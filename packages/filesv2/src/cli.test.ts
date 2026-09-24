import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { hc } from "hono/client";
import filesCli from "./cli";
import type { AdminResult, InventoryEntry } from "./contracts";

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
