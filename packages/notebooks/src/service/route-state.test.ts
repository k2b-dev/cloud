import { describe, expect, test } from "bun:test";
import { loadEditableNoteRouteData } from "./route-state";

const base = {
  notebookId: "11111111-1111-4111-8111-111111111111",
  notebookShortId: "book01",
  origin: "https://cloud.example.test",
  canWrite: true,
  defaultPresentationMode: "write" as const,
  userId: "22222222-2222-4222-8222-222222222222",
  bypassAccess: false,
};

describe("notebook route state public IDs", () => {
  test("does not serve editable state for Book defaults, explicit read views, or read grants", async () => {
    const href = "/app/notebooks/book01/notes/note01";
    for (const args of [
      { ...base, href, defaultPresentationMode: "book" as const },
      { ...base, href, defaultPresentationMode: "readonly" as const },
      { ...base, href: `${href}?mode=book` },
      { ...base, href: `${href}?mode=readonly` },
      { ...base, href: `${href}?mode=write`, canWrite: false },
    ])
      expect(await loadEditableNoteRouteData(args)).toEqual({ kind: "fallback", reason: "readonly" });
  });
  test("rejects legacy UUID note URLs before resolving data", async () => {
    const result = await loadEditableNoteRouteData({
      ...base,
      href: "/app/notebooks/book01/notes/33333333-3333-4333-8333-333333333333",
    });

    expect(result).toEqual({ kind: "fallback", reason: "invalid-target" });
  });

  test("rejects non-canonical notebook IDs", async () => {
    const result = await loadEditableNoteRouteData({
      ...base,
      href: "/app/notebooks/11111111-1111-4111-8111-111111111111/notes/note01",
    });

    expect(result).toEqual({ kind: "fallback", reason: "invalid-target" });
  });
});
