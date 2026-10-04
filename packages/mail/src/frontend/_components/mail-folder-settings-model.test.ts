import { describe, expect, test } from "bun:test";
import type { FolderDisplay } from "../../contracts";
import { mailFolderDisplayStates, mailFolderDisplayToStore, mailFolderSettingsRows } from "./mail-folder-settings-model";

const folder = (id: string, overrides: { parentId?: string; name?: string; display?: FolderDisplay; selectable?: boolean } = {}) => ({
  id,
  parentId: overrides.parentId ?? null,
  name: overrides.name ?? id,
  display: overrides.display ?? "everywhere",
  selectable: overrides.selectable ?? true,
});

const folders = [
  folder("inbox"),
  folder("shared", { display: "folder_only" }),
  folder("team", { parentId: "shared" }),
  folder("team-important", { parentId: "team", name: "Important", display: "hidden" }),
  folder("gmail", { name: "[Gmail]", selectable: false }),
  folder("gmail-important", { parentId: "gmail", name: "Important" }),
  folder("noselect", { parentId: "gmail", selectable: false }),
  folder("noselect-child", { parentId: "noselect" }),
];

describe("folder settings tree", () => {
  test("indents subfolders, keeps a provider group's folders unindented, and names the path of duplicate names", () => {
    expect(
      mailFolderSettingsRows(folders, new Set()).map(({ folder, group, depth, hasChildren, descendantCount, path }) => ({
        id: folder.id,
        group,
        depth,
        hasChildren,
        descendantCount,
        path,
      })),
    ).toEqual([
      { id: "inbox", group: false, depth: 0, hasChildren: false, descendantCount: 0, path: null },
      { id: "shared", group: false, depth: 0, hasChildren: true, descendantCount: 2, path: null },
      { id: "team", group: false, depth: 1, hasChildren: true, descendantCount: 1, path: null },
      { id: "team-important", group: false, depth: 2, hasChildren: false, descendantCount: 0, path: "shared / team" },
      { id: "gmail", group: true, depth: 0, hasChildren: true, descendantCount: 3, path: null },
      { id: "gmail-important", group: false, depth: 0, hasChildren: false, descendantCount: 0, path: "[Gmail]" },
      // Only a top-level folder group reads as a header; a nested one stays a folder row.
      { id: "noselect", group: false, depth: 0, hasChildren: true, descendantCount: 1, path: null },
      { id: "noselect-child", group: false, depth: 1, hasChildren: false, descendantCount: 0, path: null },
    ]);
  });

  test("leaves out the subfolders of collapsed folders", () => {
    expect(mailFolderSettingsRows(folders, new Set(["shared", "gmail"])).map((row) => row.folder.id)).toEqual(["inbox", "shared", "gmail"]);
  });

  test("derives each display from the folders' own displays and names what the parents pass down", () => {
    const states = mailFolderDisplayStates(folders);

    expect(states.get("shared")).toEqual({ effectiveDisplay: "folder_only", inheritedFromFolderId: null, floor: null });
    expect(states.get("team")).toEqual({
      effectiveDisplay: "folder_only",
      inheritedFromFolderId: "shared",
      floor: { display: "folder_only", folderId: "shared" },
    });
    expect(states.get("team-important")).toEqual({
      effectiveDisplay: "hidden",
      inheritedFromFolderId: null,
      floor: { display: "folder_only", folderId: "shared" },
    });
    expect(states.get("gmail-important")).toEqual({ effectiveDisplay: "everywhere", inheritedFromFolderId: null, floor: null });
  });

  test("follows the parent when someone picks what the parent already passes down", () => {
    const states = mailFolderDisplayStates(folders);

    expect(mailFolderDisplayToStore("folder_only", states.get("team-important")!)).toBe("everywhere");
    expect(mailFolderDisplayToStore("hidden", states.get("team")!)).toBe("hidden");
    expect(mailFolderDisplayToStore("folder_only", states.get("inbox")!)).toBe("folder_only");
    expect(mailFolderDisplayToStore("everywhere", states.get("shared")!)).toBe("everywhere");
  });
});
