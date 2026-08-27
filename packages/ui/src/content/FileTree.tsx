/**
 * FileTree — path-first tree over a flat entry list (folders derived from
 * paths, explicit folder entries allowed for empty dirs). Capabilities are
 * enabled by the presence of action callbacks; without them the tree is a
 * pure read-only browser. Context menus render through the platform
 * ContextMenu. Minimal look: text rows, bevel on selection, no hover motion.
 */
import { fileIcons } from "@k2b/stdlib";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import ContextMenu from "../actions/ContextMenu";
import Dropdown, { type DropdownItem } from "../actions/Dropdown";
import { useUiMessages } from "../intl/messages";
import { allFolderPaths, buildTree, type FileTreeEntry, flattenVisible, parentOf, type TreeNode } from "./file-tree";

export type { FileTreeEntry } from "./file-tree";

/**
 * `fileIcons` (and app-supplied entry icons) may carry Tailwind colour classes.
 * @k2b/ui ships no Tailwind utilities, so only the `ti-*` glyph is kept — the
 * row owns the icon colour.
 */
const glyphOnly = (icon: string): string =>
  icon
    .split(/\s+/)
    .filter((token) => token.startsWith("ti-"))
    .join(" ");

/** Presence of a callback enables the matching UI affordance. */
export type FileTreeActions = {
  rename?: (path: string, nextName: string) => void | Promise<void>;
  remove?: (path: string) => void | Promise<void>;
  createFile?: (dirPath: string) => void | Promise<void>;
  createFolder?: (dirPath: string) => void | Promise<void>;
  /** Enables drag & drop of files and folders onto folders (and the tree root). */
  move?: (path: string, targetDir: string) => void | Promise<void>;
  /** Download menu entry — folders arrive as "Download as ZIP". */
  download?: (path: string, isFolder: boolean) => void | Promise<void>;
};

export type FileTreeProps = {
  entries: FileTreeEntry[];
  selectedPath?: string | null;
  onSelect?: (entry: FileTreeEntry) => void;
  /** Controlled expansion; omit for internal state (folders start expanded). */
  expandedPaths?: Set<string>;
  onExpandedChange?: (expanded: Set<string>) => void;
  /** Extra context-menu items per entry, merged above the built-in actions. */
  contextMenu?: (entry: FileTreeEntry) => DropdownItem[];
  actions?: FileTreeActions;
  /** Accessible name for the tree. */
  label?: string;
  class?: string;
};

export default function FileTree(props: FileTreeProps) {
  const messages = useUiMessages();
  let previousTree: TreeNode[] = [];
  const tree = createMemo(() => (previousTree = buildTree(props.entries, previousTree)));

  const [internalExpanded, setInternalExpanded] = createSignal<Set<string>>(new Set(allFolderPaths(tree())), { equals: false });
  // Newly appearing folders start expanded in uncontrolled mode.
  createEffect((previous: Set<string>) => {
    const current = new Set(allFolderPaths(tree()));
    const added = [...current].filter((path) => !previous.has(path));
    if (added.length > 0 && !props.expandedPaths) setInternalExpanded((expanded) => new Set([...expanded, ...added]));
    return current;
  }, new Set<string>());

  const expanded = () => props.expandedPaths ?? internalExpanded();
  const setExpanded = (next: Set<string>) => {
    if (props.onExpandedChange) props.onExpandedChange(next);
    if (!props.expandedPaths) setInternalExpanded(next);
  };
  const toggleFolder = (path: string) => {
    const next = new Set(expanded());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const visible = createMemo(() => flattenVisible(tree(), expanded()));
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");
  const [focusedPath, setFocusedPath] = createSignal(props.selectedPath ?? "");
  const [pendingFocusPath, setPendingFocusPath] = createSignal<string | null>(null);
  const [contextPath, setContextPath] = createSignal<string | null>(props.selectedPath ?? null);
  const [contextMenuOpen, setContextMenuOpen] = createSignal(false);
  const rowRefs = new Map<string, HTMLLIElement>();
  /** Folder currently hovered by a drag ("/" = tree root). */
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);

  const focusRow = (path: string, restoreDomFocus = true) => {
    setFocusedPath(path);
    if (!restoreDomFocus) return;
    const row = rowRefs.get(path);
    if (row?.isConnected) row.focus();
    else queueMicrotask(() => rowRefs.get(path)?.focus());
  };

  createEffect(() => {
    const rows = visible();
    const paths = new Set(rows.map((node) => node.entry.path));
    for (const path of rowRefs.keys()) if (!paths.has(path)) rowRefs.delete(path);
    const pending = pendingFocusPath();
    if (pending && rows.some((node) => node.entry.path === pending)) {
      setPendingFocusPath(null);
      focusRow(pending);
      return;
    }
    if (rows.some((node) => node.entry.path === focusedPath())) return;
    const selected = rows.find((node) => node.entry.path === props.selectedPath);
    setFocusedPath(selected?.entry.path ?? rows[0]?.entry.path ?? "");
  });

  const DRAG_MIME = "application/x-filetree-path";
  const canDrop = (event: DragEvent) => props.actions?.move && event.dataTransfer?.types.includes(DRAG_MIME);
  const handleDrop = (event: DragEvent, targetDir: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const path = event.dataTransfer?.getData(DRAG_MIME);
    if (!path || parentOf(path) === targetDir || path === targetDir || targetDir.startsWith(`${path}/`)) return;
    void props.actions?.move?.(path, targetDir);
  };

  const select = (node: TreeNode) => {
    if (node.isFolder) toggleFolder(node.entry.path);
    else props.onSelect?.(node.entry);
  };

  const commitRename = async (node: TreeNode, value: string) => {
    if (renamingPath() !== node.entry.path) return;
    setRenamingPath(null);
    const nextName = value.trim();
    focusRow(node.entry.path);
    if (!nextName || nextName === node.name || nextName.includes("/")) return;
    const parent = parentOf(node.entry.path);
    setPendingFocusPath(`${parent === "/" ? "" : parent}/${nextName}`);
    await props.actions?.rename?.(node.entry.path, nextName);
  };

  const cancelRename = (node: TreeNode) => {
    setRenamingPath(null);
    focusRow(node.entry.path);
  };

  const beginRename = (node: TreeNode) => {
    setRenameDraft(node.name);
    setRenamingPath(node.entry.path);
  };

  const menuItems = (node: TreeNode): DropdownItem[] => {
    tree();
    const items: DropdownItem[] = [...(props.contextMenu?.(node.entry) ?? [])];
    if (node.isFolder && props.actions?.createFile) {
      items.push({ icon: "ti ti-file-plus", label: messages().newFile, action: () => void props.actions?.createFile?.(node.entry.path) });
    }
    if (node.isFolder && props.actions?.createFolder) {
      items.push({
        icon: "ti ti-folder-plus",
        label: messages().newFolder,
        action: () => void props.actions?.createFolder?.(node.entry.path),
      });
    }
    if (props.actions?.download) {
      items.push({
        icon: node.isFolder ? "ti ti-file-zip" : "ti ti-download",
        label: node.isFolder ? messages().downloadAsZip : messages().download,
        action: () => void props.actions?.download?.(node.entry.path, node.isFolder),
      });
    }
    if (!node.isFolder && props.actions?.rename) {
      items.push({ icon: "ti ti-cursor-text", label: messages().rename, action: () => beginRename(node) });
    }
    if (props.actions?.remove) {
      items.push({
        icon: "ti ti-trash",
        label: messages().delete,
        variant: "danger",
        action: () => void props.actions?.remove?.(node.entry.path),
      });
    }
    return items;
  };

  const contextNode = createMemo(() => visible().find((node) => node.entry.path === contextPath()));
  const contextItems = createMemo(() => {
    const node = contextNode();
    return node ? menuItems(node) : [];
  });

  const onKeyDown = (event: KeyboardEvent, node: TreeNode) => {
    if (renamingPath()) return;
    const target = event.target;
    if (target instanceof Element && target !== rowRefs.get(node.entry.path)) return;
    const rows = visible();
    const index = rows.findIndex((row) => row.entry.path === node.entry.path);
    const focus = (next: TreeNode | undefined) => {
      if (!next) return;
      focusRow(next.entry.path);
    };
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      setContextPath(node.entry.path);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focus(rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focus(rows[Math.max(index - 1, 0)] ?? rows[0]);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focus(rows[event.key === "Home" ? 0 : rows.length - 1]);
    } else if (event.key === "ArrowRight" && node.isFolder) {
      event.preventDefault();
      if (!expanded().has(node.entry.path)) toggleFolder(node.entry.path);
      else focus(rows[index + 1]?.depth === node.depth + 1 ? rows[index + 1] : undefined);
    } else if (event.key === "ArrowLeft" && node.isFolder && expanded().has(node.entry.path)) {
      event.preventDefault();
      toggleFolder(node.entry.path);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const parent = parentOf(node.entry.path);
      focus(rows.find((row) => row.entry.path === parent));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(node);
    } else if (event.key === "F2" && !node.isFolder && props.actions?.rename) {
      event.preventDefault();
      beginRename(node);
    }
  };

  return (
    <ContextMenu
      class="k2b-content-file-tree__context-host"
      tabIndex={-1}
      label={contextNode() ? messages().actionsFor({ name: contextNode()!.name }) : messages().fileActions}
      items={contextItems()}
      disabled={contextItems().length === 0}
      onOpen={() => setContextMenuOpen(true)}
      onClose={() => {
        setContextMenuOpen(false);
        const path = contextPath();
        if (path) focusRow(path);
      }}
    >
      <ul
        class={`k2b-content-file-tree ${props.class ?? ""}`}
        data-drop-root={dropTarget() === "/" ? "true" : undefined}
        role="tree"
        aria-label={props.label ?? messages().files}
        onDragOver={(event) => {
          if (!canDrop(event)) return;
          event.preventDefault();
          if (dropTarget() === null) setDropTarget("/");
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDropTarget(null);
        }}
        onDrop={(event) => handleDrop(event, "/")}
      >
        <For each={visible()}>
          {(node) => {
            const currentNode = () => {
              tree();
              return node;
            };
            const isSelected = () => props.selectedPath === currentNode().entry.path;
            const isDropTarget = () => currentNode().isFolder && dropTarget() === currentNode().entry.path;
            const icon = () =>
              currentNode().isFolder
                ? expanded().has(currentNode().entry.path)
                  ? "ti-folder-open"
                  : "ti-folder"
                : glyphOnly(
                    currentNode().entry.icon ??
                      fileIcons.getFileIcon({
                        name: currentNode().name,
                        type: "file",
                        mimeType: currentNode().entry.mediaType ?? "text/plain",
                      }),
                  );
            const hasItems = () => menuItems(node).length > 0;
            return (
              <li
                ref={(element) => {
                  rowRefs.set(node.entry.path, element);
                }}
                class="k2b-content-file-tree__item"
                role="treeitem"
                tabIndex={renamingPath() === node.entry.path ? -1 : focusedPath() === node.entry.path ? 0 : -1}
                aria-label={currentNode().name}
                aria-level={currentNode().depth + 1}
                aria-selected={isSelected()}
                aria-expanded={currentNode().isFolder ? expanded().has(currentNode().entry.path) : undefined}
                aria-haspopup={hasItems() ? "menu" : undefined}
                data-context-open={contextMenuOpen() && contextPath() === node.entry.path ? "true" : undefined}
                onFocus={() => {
                  setFocusedPath(node.entry.path);
                  setContextPath(node.entry.path);
                }}
                onKeyDown={(event) => onKeyDown(event, node)}
                onContextMenu={() => setContextPath(node.entry.path)}
              >
                <Show
                  when={renamingPath() === node.entry.path}
                  fallback={
                    <div
                      data-state={isSelected() ? "selected" : isDropTarget() ? "drop-target" : "idle"}
                      class="k2b-content-file-tree__row"
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        class="k2b-content-file-tree__select"
                        style={{ "padding-left": `${6 + currentNode().depth * 14}px` }}
                        title={currentNode().entry.path}
                        draggable={Boolean(props.actions?.move)}
                        onDragStart={(event) => event.dataTransfer?.setData(DRAG_MIME, node.entry.path)}
                        onDragOver={(event) => {
                          if (!node.isFolder || !canDrop(event)) return;
                          event.preventDefault();
                          event.stopPropagation();
                          setDropTarget(node.entry.path);
                        }}
                        onDragLeave={() => {
                          if (isDropTarget()) setDropTarget(null);
                        }}
                        onDrop={(event) => node.isFolder && handleDrop(event, node.entry.path)}
                        onClick={(event) => {
                          event.currentTarget.closest<HTMLElement>('[role="treeitem"]')?.focus();
                          select(node);
                        }}
                      >
                        <i class={`ti ${icon()} k2b-content-file-tree__icon`} aria-hidden="true" />
                        <span class="k2b-content-file-tree__name">{currentNode().name}</span>
                        <Show when={currentNode().entry.badge}>
                          <span class="k2b-content-file-tree__badge">{currentNode().entry.badge}</span>
                        </Show>
                      </button>
                      <Show when={hasItems()}>
                        <Dropdown.Root position="bottom-left" items={menuItems(node)} label={`Actions for ${currentNode().name}`}>
                          <Dropdown.Trigger
                            appearance="plain"
                            tabIndex={-1}
                            class="k2b-content-file-tree__actions"
                            label={`Actions for ${currentNode().name}`}
                            title={messages().actions}
                          >
                            <i class="ti ti-dots" aria-hidden="true" />
                            <span class="k2b-sr-only">Actions for {currentNode().name}</span>
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </Show>
                    </div>
                  }
                >
                  <input
                    class="k2b-content-file-tree__rename"
                    style={{
                      "margin-left": `${6 + currentNode().depth * 14}px`,
                      width: `calc(100% - ${6 + currentNode().depth * 14}px)`,
                    }}
                    value={renameDraft()}
                    ref={(element) =>
                      requestAnimationFrame(() => {
                        element.focus();
                        element.select();
                      })
                    }
                    onInput={(event) => setRenameDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") void commitRename(node, event.currentTarget.value);
                      if (event.key === "Escape") cancelRename(node);
                    }}
                    onBlur={(event) => void commitRename(node, event.currentTarget.value)}
                  />
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </ContextMenu>
  );
}
