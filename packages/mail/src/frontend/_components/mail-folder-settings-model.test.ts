import { describe, expect, test } from "bun:test";
import type { FolderDisplay } from "../../contracts";
import { mailFolderDisplayStates, mailFolderDisplayToStore, mailFolderSettingsRows } from "./mail-folder-settings-model";

const folder = (
  id: string,
  overrides: { parentId?: string; name?: string; display?: FolderDisplay; selectable?: boolean; displayNeutral?: boolean } = {},
) => ({
  id,
  parentId: overrides.parentId ?? null,
  name: overrides.name ?? id,
  display: overrides.display ?? "everywhere",
  selectable: overrides.selectable ?? true,
  displayNeutral: overrides.displayNeutral ?? false,
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
      mailFolderSettingsRows(folders, new Set()).map(({ folder, parentRowId, group, depth, hasChildren, descendantCount, path }) => ({
        id: folder.id,
        parentRowId,
        group,
        depth,
        hasChildren,
        descendantCount,
        path,
      })),
    ).toEqual([
      { id: "inbox", parentRowId: null, group: false, depth: 0, hasChildren: false, descendantCount: 0, path: null },
      { id: "shared", parentRowId: null, group: false, depth: 0, hasChildren: true, descendantCount: 2, path: null },
      { id: "team", parentRowId: "shared", group: false, depth: 1, hasChildren: true, descendantCount: 1, path: null },
      {
        id: "team-important",
        parentRowId: "team",
        group: false,
        depth: 2,
        hasChildren: false,
        descendantCount: 0,
        path: "shared / team",
      },
      { id: "gmail", parentRowId: null, group: true, depth: 0, hasChildren: true, descendantCount: 3, path: null },
      // A group's folders are listed under it, but start at the top level.
      { id: "gmail-important", parentRowId: "gmail", group: false, depth: 0, hasChildren: false, descendantCount: 0, path: "[Gmail]" },
      // Only a top-level folder group reads as a header; a nested one stays a folder row.
      { id: "noselect", parentRowId: "gmail", group: false, depth: 0, hasChildren: true, descendantCount: 1, path: null },
      { id: "noselect-child", parentRowId: "noselect", group: false, depth: 1, hasChildren: false, descendantCount: 0, path: null },
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

  test("lets Only in the folder from a parent pass a neutral folder by, and Hidden apply to it", () => {
    const states = mailFolderDisplayStates([
      folder("support", { display: "folder_only" }),
      folder("support-sent", { parentId: "support", displayNeutral: true }),
      folder("support-trash", { parentId: "support", display: "hidden", displayNeutral: true }),
      folder("archive", { display: "hidden" }),
      folder("archive-trash", { parentId: "archive", displayNeutral: true }),
    ]);

    // Sent shows like Everywhere: it never decides what the combined views show, so the parent's choice changes nothing.
    expect(states.get("support-sent")).toEqual({ effectiveDisplay: "everywhere", inheritedFromFolderId: null, floor: null });
    // A hidden Trash can be shown again without loosening its parent; picking Everywhere stores Everywhere.
    expect(states.get("support-trash")).toEqual({ effectiveDisplay: "hidden", inheritedFromFolderId: null, floor: null });
    expect(mailFolderDisplayToStore("everywhere", states.get("support-trash")!)).toBe("everywhere");
    // A hidden parent still hides it.
    expect(states.get("archive-trash")).toEqual({
      effectiveDisplay: "hidden",
      inheritedFromFolderId: "archive",
      floor: { display: "hidden", folderId: "archive" },
    });
  });

  test("follows the parent when someone picks what the parent already passes down", () => {
    const states = mailFolderDisplayStates(folders);

    expect(mailFolderDisplayToStore("folder_only", states.get("team-important")!)).toBe("everywhere");
    expect(mailFolderDisplayToStore("hidden", states.get("team")!)).toBe("hidden");
    expect(mailFolderDisplayToStore("folder_only", states.get("inbox")!)).toBe("folder_only");
    expect(mailFolderDisplayToStore("everywhere", states.get("shared")!)).toBe("everywhere");
  });
});
