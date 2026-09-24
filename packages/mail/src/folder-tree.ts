/** The fields that place a folder in its hierarchy. Browser views and server read models both provide them. */
export type MailFolderTreeEntry = { id: string; parentId: string | null; name: string };

export type MailFolderTreeNode<T extends MailFolderTreeEntry = MailFolderTreeEntry> = {
  folder: T;
  children: MailFolderTreeNode<T>[];
};

const createsCycle = <T extends MailFolderTreeEntry>(folder: T, parent: T, byId: Map<string, T>): boolean => {
  const visited = new Set([folder.id]);
  let current: T | undefined = parent;
  while (current) {
    if (visited.has(current.id)) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
};

export const buildMailFolderTree = <T extends MailFolderTreeEntry>(folders: readonly T[]): MailFolderTreeNode<T>[] => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const nodes = new Map<string, MailFolderTreeNode<T>>(folders.map((folder) => [folder.id, { folder, children: [] }]));
  const roots: MailFolderTreeNode<T>[] = [];
  for (const folder of folders) {
    const node = nodes.get(folder.id)!;
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    if (!parent || parent.id === folder.id || createsCycle(folder, parent, byId)) {
      roots.push(node);
      continue;
    }
    nodes.get(parent.id)!.children.push(node);
  }
  return roots;
};

/** Full display paths such as `Projects / 2025 / Archive`, for flat pickers where a leaf name alone is ambiguous. */
export const mailFolderPaths = <T extends MailFolderTreeEntry>(folders: readonly T[]): Map<string, string> => {
  const paths = new Map<string, string>();
  const visit = (nodes: readonly MailFolderTreeNode<T>[], parentPath: string | null) => {
    for (const node of nodes) {
      const path = parentPath === null ? node.folder.name : `${parentPath} / ${node.folder.name}`;
      paths.set(node.folder.id, path);
      visit(node.children, path);
    }
  };
  visit(buildMailFolderTree(folders), null);
  return paths;
};
