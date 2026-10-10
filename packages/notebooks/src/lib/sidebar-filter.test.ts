import { describe, expect, test } from "bun:test";
import { hasOnlySidebarFilterQuery, parseSidebarFilter, withSidebarFilter } from "./sidebar-filter";

describe("sidebar filter in the address", () => {
  test("parses the favorites, recent and tag lists and normalizes the tag", () => {
    expect(parseSidebarFilter(new URLSearchParams("view=favorites"))).toEqual({ view: "favorites" });
    expect(parseSidebarFilter(new URLSearchParams("view=recents"))).toEqual({ view: "recents" });
    expect(parseSidebarFilter(new URLSearchParams("view=tag&tag=Recipe"))).toEqual({ view: "tag", tag: "recipe" });
  });

  test("shows the tree for incomplete, unknown and old Navigator folder views", () => {
    expect(parseSidebarFilter(new URLSearchParams("view=tag"))).toEqual({});
    expect(parseSidebarFilter(new URLSearchParams("view=unknown"))).toEqual({});
    expect(parseSidebarFilter(new URLSearchParams("view=folder&folder=abc123"))).toEqual({});
  });

  test("replaces the filter without stale fields and keeps other parameters", () => {
    const href = withSidebarFilter("/app/notebooks/book/notes/note?mode=write&view=tag&tag=old", { view: "favorites" });
    expect(href).toBe("/app/notebooks/book/notes/note?mode=write&view=favorites");
    expect(withSidebarFilter(href, {})).toBe("/app/notebooks/book/notes/note?mode=write");
    // An old Navigator link loses its folder along with the view.
    expect(withSidebarFilter("/app/notebooks/book/notes/note?view=folder&folder=abc123", {})).toBe("/app/notebooks/book/notes/note");
  });

  test("recognizes addresses that differ only in the filter", () => {
    expect(hasOnlySidebarFilterQuery(new URLSearchParams("view=recents"))).toBe(true);
    expect(hasOnlySidebarFilterQuery(new URLSearchParams("view=folder&folder=abc123"))).toBe(true);
    expect(hasOnlySidebarFilterQuery(new URLSearchParams("mode=versions"))).toBe(false);
  });
});
