import { expect, test } from "bun:test";
import type { CodePermission, CodeVersionManifest } from "@k2b/cloud/code";
import { publicRouteReadRefusals } from "./public-route-reads";

const route = (entrypoint: string, isPublic: boolean, ownerData = false): CodeVersionManifest["entrypoints"][number] => ({
  kind: "route",
  entrypoint,
  route: { method: "GET", path: `/${entrypoint.length}`, public: isPublic, ...(ownerData ? { audience: "owner-data" as const } : {}) },
  cron: null,
  file: "code.ts",
  line: 1,
});
const manifest = {
  entrypoints: [route("route:GET:/open", true), route("route:GET:/report", true, true), route("route:GET:/members", false)],
};
const query = (localId: string) => ({ localId }) as never;
const catalogs = new Map([
  ["pulse", { appId: "pulse", queries: [query("base.sql.run"), query("base.list")], code: { owners: [], publicRoutes: false } } as never],
  ["grids", { appId: "grids", queries: [query("table.read"), query("table.list")] } as never],
  ["spaces", { appId: "spaces", queries: [] } as never],
]);
const permission = (operation: string, target: CodePermission["target"], entrypoints?: string[]): CodePermission => ({
  operation,
  target,
  file: "code.ts",
  line: 7,
  ...(entrypoints ? { entrypoints } : {}),
});
const codes = (refusals: ReturnType<typeof publicRouteReadRefusals>) => refusals.map((entry) => [entry.code, entry.line]);

test("a public route never calls a Query of an app that keeps its data off public routes, also with owner-data", () => {
  const refused = publicRouteReadRefusals(
    manifest,
    [
      permission("pulse.base.list", null, ["route:GET:/report"]),
      permission("pulse.base.sql.run", { type: "pulse.base", id: null }, ["route:GET:/open"]),
    ],
    catalogs,
    "de",
  );
  expect(codes(refused)).toEqual([
    ["code_public_route_reads", 7],
    ["code_public_route_reads", 7],
  ]);
  expect(refused[0]?.message).toContain("pulse.base.list");
});

test("any other Query on a public route needs owner-data; actions and member routes stay allowed", () => {
  expect(codes(publicRouteReadRefusals(manifest, [permission("grids.table.list", null, ["route:GET:/open"])], catalogs, "en"))).toEqual([
    ["code_public_route_reads", 7],
  ]);
  expect(
    publicRouteReadRefusals(
      manifest,
      [
        permission("grids.table.list", null, ["route:GET:/report"]),
        permission("pulse.base.sql.run", { type: "pulse.base", id: "Base01" }, ["route:GET:/members"]),
        permission("spaces.task.create", { type: "spaces.space", id: "S1" }, ["route:GET:/open"]),
      ],
      catalogs,
      "en",
    ),
  ).toEqual([]);
});

test("a call the checker could not place counts for every public route", () => {
  expect(publicRouteReadRefusals(manifest, [permission("grids.table.read", null)], catalogs, "en")).toHaveLength(1);
  expect(
    publicRouteReadRefusals(
      { entrypoints: [route("route:GET:/report", true, true)] },
      [permission("grids.table.read", null)],
      catalogs,
      "en",
    ),
  ).toEqual([]);
  expect(
    publicRouteReadRefusals({ entrypoints: [route("route:GET:/members", false)] }, [permission("pulse.base.list", null)], catalogs, "en"),
  ).toEqual([]);
});
