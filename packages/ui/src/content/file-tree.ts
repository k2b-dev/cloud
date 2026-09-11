/**
 * Tree shaping for FileTree — flat paths in, sorted nodes out.
 *
 * Kept beside the component rather than inside it because it is pure: no JSX,
 * no reactivity, nothing that needs a DOM. That is also what makes it testable
 * — a test importing the .tsx pulls the whole component through Bun's JSX
 * transform, which resolves against the root tsconfig and lands on the React
 * runtime. Same reason `file-view-preview.ts` sits next to FileView.
 */

export type FileTreeEntry = {
  /** Canonical identity, e.g. "/input/report.csv". */
  path: string;
  /** Optional presentation label; path remains the identity and rename target. */
  displayName?: string;
  /** Folders are usually implicit from paths — explicit entries model empty dirs. */
  kind?: "file" | "folder";
  size?: number;
  mediaType?: string;
  updatedAt?: string;
  /** Icon override (tabler class without "ti " prefix); default derives from the name. */
  icon?: string;
  /** Small trailing badge, e.g. "ro" on read-only mounts. */
  badge?: string;
};

export type TreeNode = {
  entry: FileTreeEntry;
  name: string;
  depth: number;
  isFolder: boolean;
  children: TreeNode[];
};

/** Containing directory of a path; "/" for top-level entries. */
export const parentOf = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
};

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1) || path;

const nodesByPath = (nodes: TreeNode[]): Map<string, TreeNode> => {
  const result = new Map<string, TreeNode>();
  const visit = (node: TreeNode) => {
    result.set(node.entry.path, node);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return result;
};

/**
 * Flat paths → sorted tree (folders first, then files, both alphabetical).
 *
 * Passing the previous tree preserves object identity by path while updating
 * the cached node in place. Solid's keyed `<For>` can then keep rows, rename
 * inputs, and focus alive even when a refetch changes metadata.
 */
export const buildTree = (entries: FileTreeEntry[], previous: TreeNode[] = []): TreeNode[] => {
  const byPath = new Map<string, FileTreeEntry>();
  const previousByPath = nodesByPath(previous);
  const folders = new Set<string>();
  const files = new Set(entries.filter((entry) => entry.kind !== "folder").map((entry) => entry.path));
  for (const entry of entries) {
    for (let dir = parentOf(entry.path); dir !== "/"; dir = parentOf(dir)) {
      if (files.has(dir)) {
        throw new Error(`FileTree entry conflict: "${dir}" is a file and cannot contain "${entry.path}".`);
      }
    }
  }
  for (const entry of entries) {
    byPath.set(entry.path, entry);
    if (entry.kind === "folder") folders.add(entry.path);
    // Register all ancestor folders of every entry.
    for (let dir = parentOf(entry.path); dir !== "/"; dir = parentOf(dir)) folders.add(dir);
  }
  const childrenByParent = new Map<string, string[]>();
  for (const path of new Set([...byPath.keys(), ...folders])) {
    if (path === "/") continue;
    const parent = parentOf(path);
    const children = childrenByParent.get(parent);
    if (children) children.push(path);
    else childrenByParent.set(parent, [path]);
  }

  const nodeFor = (path: string, depth: number): TreeNode => {
    const entry = byPath.get(path) ?? { path, kind: "folder" as const };
    const isFolder = folders.has(path);
    const old = previousByPath.get(path);
    if (old) {
      old.entry = entry;
      old.name = nameOf(path);
      old.depth = depth;
      old.isFolder = isFolder;
      return old;
    }
    return { entry, name: nameOf(path), depth, isFolder, children: [] };
  };

  const childrenOf = (dir: string, depth: number): TreeNode[] => {
    const nodes = (childrenByParent.get(dir) ?? []).map((path) => {
      const node = nodeFor(path, depth);
      if (node.isFolder) node.children = childrenOf(node.entry.path, depth + 1);
      return node;
    });
    return nodes.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1));
  };

  return childrenOf("/", 0);
};

export const flattenVisible = (nodes: TreeNode[], expanded: Set<string>): TreeNode[] =>
  nodes.flatMap((node) => [node, ...(node.isFolder && expanded.has(node.entry.path) ? flattenVisible(node.children, expanded) : [])]);

export const allFolderPaths = (nodes: TreeNode[]): string[] =>
  nodes.flatMap((node) => (node.isFolder ? [node.entry.path, ...allFolderPaths(node.children)] : []));
