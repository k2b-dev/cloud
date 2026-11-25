import { describe, expect, test } from "bun:test";
import { bookNavigationTarget } from "./book-state";

const current = "https://cloud.example.test/app/notebooks/book01/notes/note01?mode=book";
describe("Book navigation targets", () => {
  test("keeps notebook roots, note links, filters and anchors inside Book", () => {
    for (const path of [
      "/app/notebooks/book01",
      "/app/notebooks/book01/",
      "/app/notebooks/book01/notes/note02#heading",
      "/app/notebooks/book01/notes/note02?blocks=3.2",
    ]) {
      const target = bookNavigationTarget(path, current, "book01");
      expect(target?.origin).toBe("https://cloud.example.test");
      expect(target?.searchParams.get("mode")).toBe("book");
    }
  });
  test("leaves other notebooks, origins and presentation modes to document navigation", () => {
    for (const path of [
      "https://other.example.test/app/notebooks/book01/notes/note02",
      "https://user@cloud.example.test/app/notebooks/book01/notes/note02",
      "/app/notebooks/book02/notes/note02",
      "/app/notebooks/book012/notes/note02",
      "/app/notebooks/book01/notes/not-a-short-id",
      "/app/notebooks/book01/attachments",
      // a tag is a filter of the notes list, which is no Book page
      "/app/notebooks/book01/tags/hr?search=guide&page=2",
      "/app/notebooks/book01/notes?tag=hr",
      "/app/notebooks/book01/notes/note01?mode=write",
      "/app/notebooks/book01/notes/note01?mode=readonly",
      "/app/notebooks/book01/notes/note01?mode=versions",
      "javascript:alert(1)",
    ])
      expect(bookNavigationTarget(path, current, "book01")).toBeNull();
  });
});
