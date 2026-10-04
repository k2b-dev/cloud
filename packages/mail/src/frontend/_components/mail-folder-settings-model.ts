import type { FolderDisplay } from "../../contracts";
import { inheritFolderDisplays } from "../../folder-display-rules";
import { buildMailFolderTree, type MailFolderTreeNode } from "../../folder-tree";
import type { MailFolderView } from "../../service/messages";

type SettingsFolder = Pick<MailFolderView, "id" | "parentId" | "name" | "display" | "selectable" | "displayNeutral">;

export type MailFolderSettingsRow<T extends SettingsFolder> = {
  folder: T;
  /** The row this folder is listed under, or null at the top level. */
  parentRowId: string | null;
  /** A top-level folder that only holds other folders, such as Gmail's `[Gmail]`. It reads as a header and adds no indent. */
  group: boolean;
  depth: number;
  hasChildren: boolean;
  descendantCount: number;
  /** The parent path, such as `Shared / Accounting`, when another folder has the same name. */
  path: string | null;
};

const countDescendants = (node: MailFolderTreeNode<SettingsFolder>): number =>
  node.children.reduce((count, child) => count + 1 + countDescendants(child), 0);

/** The rows of the folder settings tree in provider order, without the subfolders of collapsed folders. */
export const mailFolderSettingsRows = <T extends SettingsFolder>(
  folders: readonly T[],
  collapsedIds: ReadonlySet<string>,
): MailFolderSettingsRow<T>[] => {
  const nameCounts = new Map<string, number>();
  for (const folder of folders) nameCounts.set(folder.name, (nameCounts.get(folder.name) ?? 0) + 1);
  const rows: MailFolderSettingsRow<T>[] = [];
  const visit = (nodes: readonly MailFolderTreeNode<T>[], depth: number, ancestors: readonly string[], parentRowId: string | null) => {
    for (const node of nodes) {
      const group = parentRowId === null && !node.folder.selectable && node.children.length > 0;
      rows.push({
        folder: node.folder,
        parentRowId,
        group,
        depth,
        hasChildren: node.children.length > 0,
        descendantCount: countDescendants(node),
        path: ancestors.length > 0 && (nameCounts.get(node.folder.name) ?? 0) > 1 ? ancestors.join(" / ") : null,
      });
      if (!collapsedIds.has(node.folder.id))
        visit(node.children, group ? depth : depth + 1, [...ancestors, node.folder.name], node.folder.id);
    }
  };
  visit(buildMailFolderTree(folders), 0, [], null);
  return rows;
};

export type MailFolderDisplayState = {
  effectiveDisplay: FolderDisplay;
  /** The parent whose stricter display applies, or null when the folder's own display applies. */
  inheritedFromFolderId: string | null;
  /** The display the parents pass down, which the folder can tighten but not loosen, and the folder that sets it. */
  floor: { display: FolderDisplay; folderId: string } | null;
};

/**
 * Each folder's display from the folders' own displays, so a change shows on the folder and every subfolder at
 * once, before the server confirms it.
 */
export const mailFolderDisplayStates = (folders: readonly SettingsFolder[]): Map<string, MailFolderDisplayState> => {
  const inherited = inheritFolderDisplays(folders);
  return new Map(
    folders.map((folder): [string, MailFolderDisplayState] => {
      const own = inherited.get(folder.id)!;
      const parent = folder.parentId ? inherited.get(folder.parentId) : undefined;
      const floor =
        folder.parentId && parent && parent.effectiveDisplay !== "everywhere"
          ? { display: parent.effectiveDisplay, folderId: parent.displayInheritedFromFolderId ?? folder.parentId }
          : null;
      // A neutral folder never decides what the combined views show, so "Only in the folder" changes nothing for it:
      // it shows like Everywhere and passes no floor. Only Hidden, which also leaves the sidebar, applies to it.
      if (folder.displayNeutral && own.effectiveDisplay === "folder_only") {
        return [folder.id, { effectiveDisplay: "everywhere", inheritedFromFolderId: null, floor: null }];
      }
      return [
        folder.id,
        {
          effectiveDisplay: own.effectiveDisplay,
          inheritedFromFolderId: own.displayInheritedFromFolderId,
          floor: folder.displayNeutral && floor?.display === "folder_only" ? null : floor,
        },
      ];
    }),
  );
};

/**
 * The display to store when someone picks `chosen`. Picking what the parents already pass down follows them, so
 * the folder loosens again with its parent.
 */
export const mailFolderDisplayToStore = (chosen: FolderDisplay, state: MailFolderDisplayState): FolderDisplay =>
  state.floor && chosen === state.floor.display ? "everywhere" : chosen;
