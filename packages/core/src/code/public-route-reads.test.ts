import { expect, test } from "bun:test";
import type { CodePermission, CodeVersionManifest } from "@k2b/cloud/code";
import { publicRouteReadRefusals } from "./public-route-reads";

const route = (entrypoint: string, isPublic: boolean): CodeVersionManifest["entrypoints"][number] => ({
  kind: "route",
  entrypoint,
  route: { method: "GET", path: `/${entrypoint.length}`, public: isPublic },
  cron: null,
  file: "code.ts",
  line: 1,
});
const manifest = { entrypoints: [route("route:GET:/open", true), route("route:GET:/members", false)] };
const query = (localId: string) => ({ localId }) as never;
const catalogs = new Map([
  [
    "pulse",
    {
      appId: "pulse",
      types: [{ localId: "base", reader: "base.read" }],
      queries: [query("base.read"), query("base.sql.run"), query("base.list")],
      code: { owners: [], noPublicRoutes: ["base"] },
    } as never,
  ],
  ["grids", { appId: "grids", types: [{ localId: "table", reader: "table.read" }], queries: [query("table.read")] } as never],
]);
const permission = (operation: string, target: CodePermission["target"], entrypoints?: string[]): CodePermission => ({
  operation,
  target,
  file: "code.ts",
  line: 7,
  ...(entrypoints ? { entrypoints } : {}),
});

test("a public route that reads a no-public type through a target or its reader is refused at the call", () => {
  const refused = publicRouteReadRefusals(
    manifest,
    [
      permission("pulse.base.sql.run", { type: "pulse.base", id: null }, ["route:GET:/open"]),
      permission("pulse.base.read", null, ["route:GET:/open"]),
    ],
    catalogs,
    "de",
  );
  expect(refused.map((entry) => [entry.code, entry.line])).toEqual([
    ["code_public_route_private_data", 7],
    ["code_public_route_private_data", 7],
  ]);
  expect(refused[0]?.message).toContain("pulse.base");
});

test("member routes, other types and lists without a resource stay allowed", () => {
  expect(
    publicRouteReadRefusals(
      manifest,
      [
        permission("pulse.base.sql.run", { type: "pulse.base", id: "Base01" }, ["route:GET:/members"]),
        permission("grids.table.read", null, ["route:GET:/open"]),
        permission("pulse.base.list", null, ["route:GET:/open"]),
      ],
      catalogs,
      "en",
    ),
  ).toEqual([]);
});

test("a read the checker could not place counts for the public route", () => {
  expect(
    publicRouteReadRefusals(manifest, [permission("pulse.base.sql.run", { type: "pulse.base", id: null })], catalogs, "en"),
  ).toHaveLength(1);
  expect(
    publicRouteReadRefusals(
      { entrypoints: [route("route:GET:/members", false)] },
      [permission("pulse.base.sql.run", { type: "pulse.base", id: null })],
      catalogs,
      "en",
    ),
  ).toEqual([]);
});
