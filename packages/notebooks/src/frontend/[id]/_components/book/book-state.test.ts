import { describe, expect, test } from "bun:test";
import { bookNavigationTarget } from "./book-state";

const current = "https://cloud.example.test/app/notebooks/book01/notes/note01?mode=book";
describe("Book navigation targets", () => {
  test("keeps notebook roots, note links, tags, filters and anchors inside Book", () => {
    for (const path of [
      "/app/notebooks/book01",
      "/app/notebooks/book01/",
      "/app/notebooks/book01/notes/note02#heading",
      "/app/notebooks/book01/tags/a%20tag?search=guide&page=2",
    ]) {
      const target = bookNavigationTarget(path, current, "book01");
      expect(target?.origin).toBe("https://cloud.example.test");
      expect(target?.searchParams.get("mode")).toBe("book");
    }
    const tag = bookNavigationTarget("/app/notebooks/book01/tags/hr?search=guide&page=2", current, "book01")!;
    expect(tag.searchParams.get("search")).toBe("guide");
    expect(tag.searchParams.get("page")).toBe("2");
  });
  test("leaves other notebooks, origins and presentation modes to document navigation", () => {
    for (const path of [
      "https://other.example.test/app/notebooks/book01/notes/note02",
      "https://user@cloud.example.test/app/notebooks/book01/notes/note02",
      "/app/notebooks/book02/notes/note02",
      "/app/notebooks/book012/notes/note02",
      "/app/notebooks/book01/notes/not-a-short-id",
      "/app/notebooks/book01/attachments",
      "/app/notebooks/book01/notes/note01?mode=write",
      "/app/notebooks/book01/notes/note01?mode=readonly",
      "/app/notebooks/book01/notes/note01?mode=versions",
      "javascript:alert(1)",
    ])
      expect(bookNavigationTarget(path, current, "book01")).toBeNull();
  });
});
