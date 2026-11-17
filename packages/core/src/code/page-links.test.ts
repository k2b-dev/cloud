import { expect, test } from "bun:test";
import { type CodeCheckedVersionManifest, CodePageLinksSchema } from "@k2b/cloud/contracts";
import { describeCodePages } from "./page-links";

const route = (
  path: string,
  options: { method?: "GET" | "ALL" | "POST"; public?: boolean; page?: boolean; title?: string } = {},
): CodeCheckedVersionManifest["entrypoints"][number] => ({
  kind: "route",
  entrypoint: `route:${options.method ?? "GET"}:${path}`,
  file: "code.ts",
  line: 1,
  cron: null,
  ...(options.title ? { title: options.title } : {}),
  route: {
    method: options.method ?? "GET",
    path,
    public: options.public ?? false,
    ...(options.page === undefined ? {} : { page: options.page }),
  },
});
const version = (entrypoints: CodeCheckedVersionManifest["entrypoints"]) => ({ id: "version-7", manifest: { entrypoints } });

test("only private literal GET/ALL pages open; legacy manifests retain their links", () => {
  const result = describeCodePages(
    "c_demo",
    version([
      route("/archive", { page: true, title: "Archiv" }),
      route("/", { page: true }),
      route("/all", { method: "ALL", page: true }),
      route("/legacy"),
      route("/data", { page: false }),
      route("/input", { method: "POST", page: true }),
      route("/public", { public: true, page: true }),
      route("/items/:name", { page: true }),
      { kind: "manual", entrypoint: "manual", file: "code.ts", line: 1, cron: null },
    ]),
  );
  expect(CodePageLinksSchema.parse(result)).toEqual(result);
  expect(result).toEqual({
    versionId: "version-7",
    homeUrl: "/code/c_demo/",
    pages: [
      { entrypoint: "route:GET:/", title: null, path: "/", isRoot: true, href: "/code/c_demo/" },
      { entrypoint: "route:GET:/archive", title: "Archiv", path: "/archive", isRoot: false, href: "/code/c_demo/archive" },
      { entrypoint: "route:ALL:/all", title: null, path: "/all", isRoot: false, href: "/code/c_demo/all" },
      { entrypoint: "route:GET:/legacy", title: null, path: "/legacy", isRoot: false, href: "/code/c_demo/legacy" },
    ],
  });
});
test("home falls back to declaration order; empty versions have no home", () => {
  const fallback = describeCodePages("c_other", version([route("/second"), route("/first")]));
  expect(fallback.homeUrl).toBe("/code/c_other/second");
  expect(describeCodePages("c_demo", version([route("/", { page: false })]))).toEqual({
    versionId: "version-7",
    homeUrl: null,
    pages: [],
  });
});
test("the projection preserves declared titles and neutral paths, without presentation or locale", () => {
  const v = version([route("/")]);
  expect(describeCodePages("c_demo", v).pages[0]).toMatchObject({ title: null, path: "/", isRoot: true });
  const named = describeCodePages("c_demo", version([route("/", { title: "Übersicht" })]));
  expect(named.pages[0]!.title).toBe("Übersicht");
  expect(v.manifest.entrypoints[0]!.title).toBeUndefined();
});

test("only the entry hosting would select for GET can open, including ALL, parameters and trailing slashes", () => {
  for (const entries of [
    [route("/", { method: "ALL", public: true }), route("/", { page: true })],
    [route("/:name", { public: true }), route("/archive", { page: true })],
    [route("/:name", { page: false }), route("/archive", { page: true })],
    [route("/archive/", { page: false }), route("/archive", { page: true })],
  ])
    expect(describeCodePages("c_demo", version(entries)).pages).toEqual([]);
  const entries = [route("/archive", { page: true }), route("/:name", { public: true }), route("/", { page: true })];
  const visible = describeCodePages("c_demo", version(entries));
  expect(visible.pages.map((page) => page.path)).toEqual(["/", "/archive"]);
  const withPost = describeCodePages("c_demo", version([route("/", { method: "POST", public: true }), route("/", { page: true })]));
  expect(withPost.pages).toHaveLength(1);
});
