import { expect, test } from "bun:test";
import { adminHref, parseAdminLocation } from "./admin-location";
import { filesUrl, pathCrumbs, referenceHref } from "./urls";

test("navigation retains opaque identities and filenames as query values", () => {
  const url = new URL(filesUrl("freeipa:group:123", "Budget #1/über uns?", "next/+="), "https://cloud.test");
  expect(url.pathname).toBe("/app/filesv2");
  expect(url.searchParams.get("base")).toBe("freeipa:group:123");
  expect(url.searchParams.get("path")).toBe("Budget #1/über uns?");
  expect(url.searchParams.get("after")).toBe("next/+=");
  expect(filesUrl()).toBe("/app/filesv2");
  expect(pathCrumbs("one/two")).toEqual([
    { name: "one", path: "one" },
    { name: "two", path: "one/two" },
  ]);
});

test("inventory pagination preserves selected area and identity kind", () => {
  const url = new URL(
    adminHref(parseAdminLocation("/admin/filesv2?view=directories&area=freeipa&kind=groups&status=orphaned&q=old"), { after: "next/name" }),
    "https://cloud.test",
  );
  expect(url.searchParams.get("area")).toBe("freeipa");
  expect(url.searchParams.get("kind")).toBe("groups");
  expect(url.searchParams.get("after")).toBe("next/name");
  expect(url.searchParams.get("view")).toBe("directories");
  expect(url.searchParams.get("status")).toBe("orphaned");
  expect(url.searchParams.get("q")).toBe("old");
});

test("paging and reload URLs preserve the whole global browse query", () => {
  const options = { sort: "modified" as const, order: "desc" as const, type: "files" as const, groupFolders: false };
  const url = new URL(filesUrl("home", "Docs", "opaque-cursor", "Docs/a.txt", "report", "folder", options), "https://cloud.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    base: "home",
    path: "Docs",
    after: "opaque-cursor",
    file: "Docs/a.txt",
    q: "report",
    scope: "folder",
    sort: "modified",
    order: "desc",
    type: "files",
    groupFolders: "false",
  });
});

test("a copied stable reference links through the deep link; path refs link to their folder and file", () => {
  const baseId = "cloud:users:6f1c2e4a-1b2c-4d3e-8f90-1234567890ab";
  const stable = `n:${baseId}:019b72cf-5200-7000-8000-000000000001`;
  expect(referenceHref(baseId, { path: "Docs/a.txt", directory: false }, stable)).toBe(`/app/filesv2/ref/${encodeURIComponent(stable)}`);
  expect(referenceHref(baseId, { path: "Docs/a.txt", directory: false }, "inline")).toBe(filesUrl(baseId, "Docs", null, "Docs/a.txt"));
  expect(referenceHref(baseId, { path: "Docs", directory: true }, "inline")).toBe(filesUrl(baseId, "Docs"));
});
