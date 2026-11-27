import { expect, test } from "bun:test";
import { adminHref, parseAdminLocation } from "./admin-location";
import { searchState } from "./search-state";
import { filesUrl, namesNoPlace, pathCrumbs, readLastBase, startBase } from "./urls";

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
  const url = new URL(filesUrl("home", "Docs", "opaque-cursor", "Docs/a.txt", null, options), "https://cloud.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    base: "home",
    path: "Docs",
    after: "opaque-cursor",
    file: "Docs/a.txt",
    sort: "modified",
    order: "desc",
    type: "files",
    groupFolders: "false",
  });
});

test("a search keeps its query, filters and order instead of the folder's options, and reads back unchanged", () => {
  const options = { sort: "modified" as const, order: "desc" as const, type: "files" as const, groupFolders: false };
  const search = {
    q: "report",
    scope: "folder" as const,
    exact: true,
    sort: "size" as const,
    order: "desc" as const,
    kind: "pdf" as const,
    size: "large" as const,
    modified: "week" as const,
  };
  const url = new URL(filesUrl("home", "Docs", "opaque-cursor", "Docs/a.txt", search, options), "https://cloud.test");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    base: "home",
    path: "Docs",
    after: "opaque-cursor",
    file: "Docs/a.txt",
    q: "report",
    scope: "folder",
    match: "exact",
    in: "name",
    kind: "pdf",
    size: "large",
    modified: "week",
    sort: "size",
    order: "desc",
  });
  expect(searchState(url.searchParams)).toEqual(search);
  // Relevance is the default with a query and keeps no order; a filter alone is a search too.
  const relevance = new URL(
    filesUrl("home", "", null, null, { ...search, sort: "relevance", scope: "tree", exact: false }),
    "https://cloud.test",
  );
  expect(relevance.search).toBe("?base=home&q=report&kind=pdf&size=large&modified=week");
  expect(searchState(new URLSearchParams("kind=image"))).toMatchObject({ q: "", kind: "image" });
  expect(searchState(new URLSearchParams("q=%20%20&kind=unknown&sort=relevance"))).toBeNull();
  expect(namesNoPlace(new URLSearchParams("modified=day"))).toBe(false);
});

test("an address without a place names none, so Files opens the storage used last", () => {
  for (const key of ["base", "path", "file", "q"]) {
    expect(namesNoPlace(new URLSearchParams({ [key]: "value" }))).toBe(false);
    expect(namesNoPlace(new URLSearchParams({ [key]: "" }))).toBe(true);
  }
  expect(namesNoPlace(new URLSearchParams())).toBe(true);
  expect(namesNoPlace(new URLSearchParams({ q: " " }))).toBe(true);
  for (const view of ["", "foo", "edit"]) expect(namesNoPlace(new URLSearchParams({ view }))).toBe(true);
  expect(namesNoPlace(new URLSearchParams({ view: "edit", file: "" }))).toBe(true);
  for (const view of ["trash", "shares", "recent", "favorites", "activity"])
    expect(namesNoPlace(new URLSearchParams({ view }))).toBe(false);
  expect(namesNoPlace(new URLSearchParams({ view: "edit", file: "report.txt" }))).toBe(false);
  expect(namesNoPlace(new URLSearchParams({ after: "cursor", sort: "modified", order: "desc" }))).toBe(true);
});

test("Files starts in the storage used last while this person reaches it, else in their personal one", () => {
  const bases = [
    { id: "team", kind: "groups", status: "existing" },
    { id: "gone", kind: "groups", status: "missing" },
    { id: "mine", kind: "users", status: "existing" },
  ];
  expect(startBase(bases, "team")?.id).toBe("team");
  // a storage this person no longer reaches, or one that is not there, is never where Files opens
  expect(startBase(bases, "foreign")?.id).toBe("mine");
  expect(startBase(bases, "gone")?.id).toBe("mine");
  expect(startBase(bases)?.id).toBe("mine");
  expect(startBase(bases.filter((base) => base.kind !== "users"))?.id).toBe("team");
  expect(startBase([])).toBeUndefined();
  expect(readLastBase("a=1; filesv2-base=cloud%3Agroups%3Awerkstatt; b=2")).toBe("cloud:groups:werkstatt");
  expect(readLastBase("filesv2-base=%E0%A4%A")).toBeUndefined();
  expect(readLastBase(undefined)).toBeUndefined();
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
  expect(namesNoPlace(new URLSearchParams("view=activity"))).toBe(false);
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
