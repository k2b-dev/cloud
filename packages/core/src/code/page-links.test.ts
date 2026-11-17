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
    "de-AT",
  );
  expect(CodePageLinksSchema.parse(result)).toEqual(result);
  expect(result).toEqual({
    versionId: "version-7",
    homeUrl: "/code/c_demo/",
    pages: [
      { entrypoint: "route:GET:/", title: "Startseite", href: "/code/c_demo/" },
      { entrypoint: "route:GET:/archive", title: "Archiv", href: "/code/c_demo/archive" },
      { entrypoint: "route:ALL:/all", title: "/all", href: "/code/c_demo/all" },
      { entrypoint: "route:GET:/legacy", title: "/legacy", href: "/code/c_demo/legacy" },
    ],
  });
});
test("home falls back to declaration order; empty versions have no home", () => {
  expect(describeCodePages("c_other", version([route("/second"), route("/first")]), "en").homeUrl).toBe("/code/c_other/second");
  expect(describeCodePages("c_demo", version([route("/", { page: false })]), "de")).toEqual({
    versionId: "version-7",
    homeUrl: null,
    pages: [],
  });
});
test("titles use the request locale without affecting another request or a reviewed title", () => {
  const v = version([route("/")]);
  expect(describeCodePages("c_demo", v, "de").pages[0]!.title).toBe("Startseite");
  expect(describeCodePages("c_demo", v, "en-GB").pages[0]!.title).toBe("Home page");
  expect(describeCodePages("c_demo", v, "de").pages[0]!.title).toBe("Startseite");
  expect(describeCodePages("c_demo", version([route("/", { title: "Übersicht" })]), "en").pages[0]!.title).toBe("Übersicht");
  expect(v.manifest.entrypoints[0]!.title).toBeUndefined();
});
