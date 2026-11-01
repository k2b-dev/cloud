import { expect, test } from "bun:test";
import { SearchQuerySchema } from "../contracts";
import { SEARCH_KINDS, searchEntries, searchRequest, searchState } from "./search-state";

const now = Date.parse("2026-10-27T11:47:12Z");

test("the default search tolerates typos, matches folder names and ranks by relevance", () => {
  const request = searchRequest({ q: "rechnung", scope: "tree", exact: false, order: "asc" }, now);
  expect(request).toEqual({
    q: "rechnung",
    scope: "tree",
    match: "fuzzy",
    in: "path",
    sort: "relevance",
    order: "asc",
    type: "all",
    groupFolders: "false",
  });
  expect(SearchQuerySchema.safeParse(request).success).toBe(true);
});

test("filters become Filegate bounds; the date window starts from the current full hour", () => {
  const request = searchRequest(
    { q: "", scope: "tree", exact: true, order: "desc", sort: "modified", kind: "pdf", size: "medium", modified: "week" },
    now,
  );
  expect(request).toMatchObject({
    match: "exact",
    in: "name",
    sort: "modified",
    ext: "pdf",
    minSize: String(1024 * 1024),
    maxSize: String(10 * 1024 * 1024 - 1),
    modifiedAfter: "2026-10-20T11:00:00.000Z",
  });
  // A second page within the same hour asks exactly the same, so its cursor stays valid.
  expect(searchRequest({ q: "", scope: "tree", exact: true, order: "desc", modified: "week" }, now + 10 * 60 * 1000)).toMatchObject({
    modifiedAfter: "2026-10-20T11:00:00.000Z",
  });
  const parsed = SearchQuerySchema.parse(request);
  expect(parsed).toMatchObject({ minSize: 1048576, maxSize: 10485759, ext: "pdf" });
  expect(searchRequest({ q: "", scope: "tree", exact: false, order: "asc", kind: "folder" }, now)).toMatchObject({ type: "directories" });
  expect(searchRequest({ q: "", scope: "tree", exact: false, order: "asc", kind: "folder" }, now)).not.toHaveProperty("ext");
});

test("every type preset is a valid extension filter", () => {
  for (const extensions of Object.values(SEARCH_KINDS).filter((items) => items.length))
    expect(SearchQuerySchema.safeParse({ ext: extensions.join(",") }).success).toBe(true);
});

test("the API rejects searches Filegate would reject, before asking it", () => {
  for (const query of [
    {},
    { q: "   " },
    { q: "a b c d e f g h i" },
    { ext: "tar.gz" },
    { ext: " , " },
    { minSize: "10", maxSize: "9" },
    { modifiedAfter: "2026-10-27T00:00:00Z", modifiedBefore: "2026-10-26T00:00:00Z" },
    { modifiedAfter: "yesterday" },
    { sort: "relevance", ext: "pdf" },
    { q: "", type: "all" },
  ])
    expect(SearchQuerySchema.safeParse(query).success).toBe(false);
  expect(SearchQuerySchema.parse({ q: "report", ext: " PDF, docx ,pdf" }).ext).toBe("pdf,docx");
});

test("a filter-only search keeps a descending name order and a folders-only search is a valid search", () => {
  const descending = { q: "", scope: "tree" as const, exact: false, order: "desc" as const, kind: "pdf" as const };
  const params = new URLSearchParams(searchEntries(descending));
  expect(params.get("order")).toBe("desc");
  // Reading the address back and writing it again keeps the order, so paging and selection keep the cursor.
  expect(searchEntries(searchState(params)!)).toEqual(searchEntries(descending));
  const folders = searchRequest({ q: "", scope: "tree", exact: false, order: "asc", kind: "folder" }, now);
  expect(SearchQuerySchema.safeParse(folders).success).toBe(true);
});
