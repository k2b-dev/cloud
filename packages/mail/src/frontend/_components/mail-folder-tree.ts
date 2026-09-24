import { buildMailFolderTree, type MailFolderTreeNode } from "../../folder-tree";
import type { MailFolderView } from "../../service/messages";

const visibleNode = <T extends MailFolderView>(node: MailFolderTreeNode<T>): MailFolderTreeNode<T> | null => {
  if (!node.folder.showInSidebar || node.folder.discoveryState !== "active" || node.folder.role === "all") return null;
  const children = node.children.flatMap((child) => {
    const visible = visibleNode(child);
    return visible ? [visible] : [];
  });
  if (!node.folder.selectable && children.length === 0) return null;
  return { folder: node.folder, children };
};

export const buildVisibleMailFolderTree = <T extends MailFolderView>(folders: readonly T[]): MailFolderTreeNode<T>[] =>
  buildMailFolderTree(folders).flatMap((node) => {
    const visible = visibleNode(node);
    return visible ? [visible] : [];
  });

export const flattenMailFolderTree = <T extends MailFolderView>(
  nodes: readonly MailFolderTreeNode<T>[],
  depth = 0,
  hiddenByParent = false,
): Array<{ folder: T; depth: number; hiddenByParent: boolean }> =>
  nodes.flatMap((node) => [
    { folder: node.folder, depth, hiddenByParent },
    ...flattenMailFolderTree(node.children, depth + 1, hiddenByParent || !node.folder.showInSidebar),
  ]);

export const excludeMailFolderTreeRoles = <T extends MailFolderView>(
  nodes: readonly MailFolderTreeNode<T>[],
  roles: ReadonlySet<string>,
): MailFolderTreeNode<T>[] =>
  nodes.flatMap((node) => {
    const children = excludeMailFolderTreeRoles(node.children, roles);
    return roles.has(node.folder.role) ? children : [{ folder: node.folder, children }];
  });
