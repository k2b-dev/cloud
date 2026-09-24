import { describe, expect, test } from "bun:test";
import { buildMailFolderTree, mailFolderPaths } from "../../folder-tree";
import type { MailFolderView } from "../../service/messages";
import { buildVisibleMailFolderTree, excludeMailFolderTreeRoles, flattenMailFolderTree } from "./mail-folder-tree";

const folder = (id: string, overrides: Partial<MailFolderView> = {}): MailFolderView => ({
  id,
  parentId: null,
  name: id,
  role: "other",
  providerRole: "other",
  configuredRole: null,
  selectable: true,
  showInSidebar: true,
  namespaceKinds: ["personal"],
  discoveryState: "active",
  missingSince: null,
  syncStatus: "current",
  total: 0,
  unread: 0,
  ...overrides,
});

describe("Mail folder tree", () => {
  test("names same-named folders by their full path for flat pickers", () => {
    const paths = mailFolderPaths([
      folder("archive-2025", { name: "Archiv", parentId: "2025" }),
      folder("projects", { name: "Projekte", selectable: false }),
      folder("2025", { name: "2025", parentId: "projects" }),
      folder("archive-root", { name: "Archiv" }),
    ]);

    expect(paths.get("archive-2025")).toBe("Projekte / 2025 / Archiv");
    expect(paths.get("archive-root")).toBe("Archiv");
  });

  test("preserves provider hierarchy and input order", () => {
    const tree = buildMailFolderTree([folder("inbox"), folder("projects"), folder("client", { parentId: "projects" }), folder("archive")]);

    expect(flattenMailFolderTree(tree).map(({ folder: item, depth }) => [item.id, depth])).toEqual([
      ["inbox", 0],
      ["projects", 0],
      ["client", 1],
      ["archive", 0],
    ]);
  });

  test("hides unavailable branches and local hidden subtrees", () => {
    const tree = buildVisibleMailFolderTree([
      folder("visible"),
      folder("hidden", { showInSidebar: false }),
      folder("hidden-child", { parentId: "hidden" }),
      folder("missing", { discoveryState: "missing" }),
      folder("missing-child", { parentId: "missing" }),
    ]);

    expect(flattenMailFolderTree(tree).map(({ folder: item }) => item.id)).toEqual(["visible"]);
  });

  test("identifies descendants whose visible parent is hidden", () => {
    const tree = buildMailFolderTree([
      folder("visible"),
      folder("hidden", { showInSidebar: false }),
      folder("child", { parentId: "hidden" }),
      folder("grandchild", { parentId: "child" }),
    ]);

    expect(flattenMailFolderTree(tree).map(({ folder: item, hiddenByParent }) => [item.id, hiddenByParent])).toEqual([
      ["visible", false],
      ["hidden", false],
      ["child", true],
      ["grandchild", true],
    ]);
  });

  test("keeps namespace containers only when they have visible children", () => {
    const tree = buildVisibleMailFolderTree([
      folder("shared", { selectable: false }),
      folder("team", { parentId: "shared" }),
      folder("empty", { selectable: false }),
    ]);

    expect(flattenMailFolderTree(tree).map(({ folder: item, depth }) => [item.id, depth])).toEqual([
      ["shared", 0],
      ["team", 1],
    ]);
  });

  test("fails safe for orphaned and cyclic provider projections", () => {
    const tree = buildMailFolderTree([
      folder("orphan", { parentId: "gone" }),
      folder("a", { parentId: "b" }),
      folder("b", { parentId: "a" }),
    ]);

    expect(new Set(flattenMailFolderTree(tree).map(({ folder: item }) => item.id))).toEqual(new Set(["orphan", "a", "b"]));
  });

  test("promotes custom children when known system folders are separated", () => {
    const tree = buildVisibleMailFolderTree([
      folder("inbox", { role: "inbox" }),
      folder("project", { parentId: "inbox" }),
      folder("customer", { parentId: "project" }),
      folder("sent", { role: "sent" }),
    ]);

    const custom = excludeMailFolderTreeRoles(tree, new Set(["inbox", "sent"]));

    expect(flattenMailFolderTree(custom).map(({ folder: item, depth }) => [item.id, depth])).toEqual([
      ["project", 0],
      ["customer", 1],
    ]);
  });
});
