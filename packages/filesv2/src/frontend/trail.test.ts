import { describe, expect, test } from "bun:test";
import { derivePageTrail } from "@k2b/cloud/ssr/page-trail";
import { snapshotTitle } from "./trail";

const base = {
  id: "b1",
  name: "mmuster",
  kind: "users" as const,
  area: "cloud" as const,
  status: "existing" as const,
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const bases = { items: [base], issues: [], editor: null };
const messages = { personal: "Personal", allStorage: "All storage" };
const trailOf = (snapshot: Parameters<typeof snapshotTitle>[0]) =>
  derivePageTrail(snapshotTitle(snapshot, "Files", messages, "en"), "/app/filesv2", "Files");
const folder = (path: string, source = `/app/filesv2?base=b1&path=${encodeURIComponent(path)}`) => ({
  source,
  bases,
  directory: { base, path, items: [], next: null },
  editor: null,
});

describe("Files reports its current page to the shell", () => {
  test("the overview is the current level above two storage roots", () => {
    const snapshot = {
      source: "/app/filesv2",
      bases: { ...bases, items: [base, { ...base, id: "b2", kind: "groups" as const }] },
      directory: null,
    };
    expect(snapshotTitle(snapshot, "Files", messages, "en")).toEqual([{ title: "Files", href: "/app/filesv2" }, { title: "All storage" }]);
    expect(trailOf(snapshot)).toEqual({ title: "All storage", ancestors: [] });
  });

  test("the plain address with one root still titles its root folder", () => {
    expect(trailOf(folder("", "/app/filesv2"))).toEqual({ title: "Personal", ancestors: [] });
  });

  test("folders at depths zero through four have a title without shell ancestors", () => {
    for (const path of ["", "A", "A/B", "A/B/C", "A/B/C/D"]) {
      expect(trailOf(folder(path))).toEqual({ title: path.split("/").at(-1) || "Personal", ancestors: [] });
    }
  });

  test("a document leads up to its folder with its row selected, or to the storage at the top", () => {
    const editor = (path: string) => ({
      source: "/app/filesv2?base=b1&view=edit",
      bases,
      directory: null,
      editor: {
        kind: "markdown" as const,
        managed: false,
        base,
        entry: { name: path.split("/").at(-1)!, path, directory: false, size: 0, modified: "2026-10-01T00:00:00Z" },
        canWrite: true,
        url: "/document",
      },
    });
    expect(trailOf(editor("Projects/plan.md"))).toEqual({
      title: "plan.md",
      ancestors: [{ title: "Projects", href: "/app/filesv2?base=b1&path=Projects&file=Projects%2Fplan.md" }],
    });
    expect(trailOf(editor("notes.md"))).toEqual({
      title: "notes.md",
      ancestors: [{ title: "Personal", href: "/app/filesv2?base=b1&file=notes.md" }],
    });
  });

  test("an authorized moved-folder notice keeps the opened folder as the current title", () => {
    expect(
      trailOf({
        ...folder("Projects/Offers"),
        directory: null,
        moved: { baseId: base.id, path: "Projects/Offers" },
      }),
    ).toEqual({ title: "Offers", ancestors: [] });
  });

  test("the app's own views and a missing listing show the app name alone", () => {
    expect(trailOf({ ...folder("Projects"), source: "/app/filesv2?view=shares" })).toEqual({ title: "Files", ancestors: [] });
    expect(trailOf({ source: "/app/filesv2", bases, directory: null, editor: null })).toEqual({ title: "Files", ancestors: [] });
  });
});
