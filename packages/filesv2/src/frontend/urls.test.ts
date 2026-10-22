import { expect, test } from "bun:test";
import { adminHref, parseAdminLocation } from "./admin-location";
import { filesUrl, pathCrumbs, referenceHref, showsOverview } from "./urls";

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

test("the plain Files address shows all storage only with multiple roots", () => {
  for (const count of [0, 1, 2]) expect(showsOverview(new URLSearchParams(), count)).toBe(count > 1);
  for (const key of ["base", "path", "file", "q"]) {
    expect(showsOverview(new URLSearchParams({ [key]: "value" }), 2)).toBe(false);
    expect(showsOverview(new URLSearchParams({ [key]: "" }), 2)).toBe(true);
  }
  expect(showsOverview(new URLSearchParams({ q: " " }), 2)).toBe(true);
  for (const view of ["", "foo", "edit"]) {
    expect(showsOverview(new URLSearchParams({ view }), 2)).toBe(true);
  }
  expect(showsOverview(new URLSearchParams({ view: "edit", file: "" }), 2)).toBe(true);
  for (const view of ["trash", "shares", "recent", "favorites"]) {
    expect(showsOverview(new URLSearchParams({ view }), 2)).toBe(false);
  }
  expect(showsOverview(new URLSearchParams({ view: "edit", file: "report.txt" }), 2)).toBe(false);
  expect(
    showsOverview(new URLSearchParams({ after: "cursor", sort: "modified", order: "desc", type: "files", groupFolders: "false" }), 2),
  ).toBe(true);
});

test("Activity filters survive the address unchanged and invalid values are refused, not replaced", async () => {
  const { activityUrl, parseActivityFilters } = await import("./urls");
  const filters = {
    baseId: "cloud:groups:vertrieb",
    path: "Kunden/Angebote 2025",
    actor: "0b4c9a52-5f7e-4c47-9d2e-6c1f1f0a7b11",
    action: "item.move" as const,
    when: "7" as const,
    q: "Angebote #1/über",
  };
  const url = new URL(activityUrl(filters), "https://cloud.test");
  expect(url.pathname).toBe("/app/filesv2");
  expect(url.searchParams.get("view")).toBe("activity");
  expect(parseActivityFilters(url.searchParams)).toEqual(filters);
  expect(activityUrl()).toBe("/app/filesv2?view=activity");
  // A path without its storage has no meaning, so it is not written.
  expect(new URL(activityUrl({ path: "Kunden" }), "https://cloud.test").searchParams.has("path")).toBe(false);
  for (const bad of ["what=item.explode", "when=8", "who=lukas", "path=Kunden", "base=b&path=../x", "base=b&path=/x"])
    expect(parseActivityFilters(new URLSearchParams(bad))).toBeNull();
  expect(parseActivityFilters(new URLSearchParams("q=%20%20"))).toEqual({});
  expect(showsOverview(new URLSearchParams("view=activity"), 3)).toBe(false);
});

test("Activity folder scope survives reload and exact scope remains exact", async () => {
  const { activityUrl, parseActivityFilters } = await import("./urls");
  for (const scope of [undefined, "item", "folder"] as const) {
    for (const path of ["Docs", ""]) {
      const filters = { baseId: "base", path, ...(scope ? { scope } : {}) };
      expect(parseActivityFilters(new URL(activityUrl(filters), "https://files.test").searchParams)).toEqual(filters);
    }
  }
  for (const bad of ["base=b&path=Docs&scope=tree", "base=b&scope=folder", "path=Docs&scope=folder"]) {
    expect(parseActivityFilters(new URLSearchParams(bad))).toBeNull();
  }
});
