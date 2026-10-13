import { describe, expect, test } from "bun:test";
import { derivePageTrail } from "@k2b/cloud/ssr/page-trail";
import { snapshotTitle } from "./trail";

const base = { id: "b1", name: "mmuster", kind: "users" as const };
const messages = { myFiles: "My files" };
const trailOf = (snapshot: Parameters<typeof snapshotTitle>[0]) =>
  derivePageTrail(snapshotTitle(snapshot, "Files", messages, "en"), "/app/filesv2", "Files");
const folder = (path: string, source = `/app/filesv2?base=b1&path=${encodeURIComponent(path)}`) => ({
  source,
  directory: { base, path, items: [], next: null } as never,
  editor: null,
});

describe("Files reports its current page to the shell", () => {
  test("folders at depths zero through four have a title without shell ancestors", () => {
    for (const path of ["", "A", "A/B", "A/B/C", "A/B/C/D"]) {
      expect(trailOf(folder(path))).toEqual({ title: path.split("/").at(-1) || "My files", ancestors: [] });
    }
  });

  test("a document leads up to its folder with its row selected, or to the storage at the top", () => {
    const editor = (path: string) => ({
      source: "/app/filesv2?base=b1&view=edit",
      directory: null,
      editor: { base, entry: { name: path.split("/").at(-1), path } } as never,
    });
    expect(trailOf(editor("Projects/plan.md"))).toEqual({
      title: "plan.md",
      ancestors: [{ title: "Projects", href: "/app/filesv2?base=b1&path=Projects&file=Projects%2Fplan.md" }],
    });
    expect(trailOf(editor("notes.md"))).toEqual({
      title: "notes.md",
      ancestors: [{ title: "My files", href: "/app/filesv2?base=b1&file=notes.md" }],
    });
  });

  test("the app's own views and a missing listing show the app name alone", () => {
    expect(trailOf({ ...folder("Projects"), source: "/app/filesv2?view=shares" })).toEqual({ title: "Files", ancestors: [] });
    expect(trailOf({ source: "/app/filesv2", directory: null, editor: null })).toEqual({ title: "Files", ancestors: [] });
  });
});
