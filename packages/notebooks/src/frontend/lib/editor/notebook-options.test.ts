import { expect, test } from "bun:test";
import { notebookUrlOptions } from "./notebook-options";

test("note links resolve to the same notebook and heading; note image sources stay unsupported", () => {
  const { resolveUrl } = notebookUrlOptions("Nb12Cd");
  expect(resolveUrl?.("link", "note://Ab12Cd#restore")).toBe("/app/notebooks/Nb12Cd/notes/Ab12Cd#heading-restore");
  expect(resolveUrl?.("image", "note://Ab12Cd#restore")).toBe("note://Ab12Cd#restore");
  for (const kind of ["image", "link"] as const) {
    expect(resolveUrl?.(kind, "attach://Ab12Cd")).toBe("/api/notebooks/Nb12Cd/attachments/Ab12Cd/content?v=1");
    expect(resolveUrl?.(kind, "https://example.test/image.png")).toBe("https://example.test/image.png");
  }
});
