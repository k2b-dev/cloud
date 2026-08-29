import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { dates, fileIcons, text } from "@k2b/stdlib";
import { dnd, mutation as mutations } from "@k2b/stdlib/solid";
import { Lightbox, type LightboxImage, Placeholder, prompts, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { apiClient } from "@/api/client";
import type { FileBaseInfo, FileInfo } from "@/contracts";
import {
  buildItemPath,
  buildSelectionKey,
  clearSelection,
  consumeHighlightedFiles,
  DETAIL_FILE_SELECT_EVENT,
  type DetailFileSelectPayload,
  FILE_LIGHTBOX_EVENT,
  FILE_SELECTION_EVENT,
  FileContext,
  type FileContextValue,
  type FileLightboxPayload,
  fileApiUrl,
  fileAppUrlForPath,
  getDetailFileFromUrl,
  parseSelectionKey,
  type SelectionKey,
  setDetailFileInUrl,
  setHighlightedFiles,
  setSelectedInUrl,
} from "./context";
import { createFileActionMutations, openFileItem } from "./FileActions";
import { DEFAULT_FILE_SETTINGS, type FileListColumn, type FileSettings, getGridSizePixels } from "./FileSettings.island";
import { filesMessages } from "../messages";

type FileListProps = {
  items: FileInfo[];
  baseType: FileBaseInfo["type"];
  baseId: string;
  currentPath: string;
  parentPath: string | null;
  settings?: FileSettings;
  initialSelected?: string[];
  bases?: FileBaseInfo[];
  hideSelection?: boolean;
  useItemPath?: boolean;
  isFiltered?: boolean;
  forceListView?: boolean;
  selectedFilePath?: string | null;
  useFullDetailKey?: boolean;
};

type DragMeta = {
  item: FileInfo;
  itemPath: string;
};

type DropMeta = {
  targetPath: string;
  label: string;
};

type MarqueeRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ActiveContextMenu = {
  x: number;
  y: number;
  item: FileInfo;
  itemPath: string;
};

const getParentPathFromItemPath = (itemPath: string) => itemPath.substring(0, itemPath.lastIndexOf("/")) || "/";

const isPointerOnInteractiveTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("button, a, input, textarea, select, [data-dnd-ignore]");

const intersects = (a: DOMRect, b: DOMRect) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);

const createRowTemplate = (columns: FileListColumn[]) => {
  const segments = ["minmax(0, 1fr)"];
  if (columns.includes("size")) segments.push("fit-content(8rem)");
  if (columns.includes("mime")) segments.push("fit-content(8.5rem)");
  if (columns.includes("modified")) segments.push("fit-content(11rem)");
  return segments.join(" ");
};

export default function FileList(props: FileListProps) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const fileActions = createFileActionMutations();
  const settings = props.settings ?? DEFAULT_FILE_SETTINGS;
  const viewMode = props.forceListView ? "list" : settings.viewMode;
  const isGrid = () => viewMode === "grid";
  const gridSize = () => getGridSizePixels(settings.gridSize);
  const gridTileWidth = createMemo(() => Math.max(gridSize() + 14, 104));
  const listColumns = createMemo<FileListColumn[]>(() => settings.listColumns ?? DEFAULT_FILE_SETTINGS.listColumns);
  const rowTemplate = createMemo(() => createRowTemplate(listColumns()));
  const isCompactList = () => settings.listDensity === "compact";
  const contextValue: FileContextValue = {
    baseType: props.baseType,
    baseId: props.baseId,
    currentPath: props.currentPath,
    bases: props.bases ?? [],
    settings,
  };

  const getItemPath = (item: FileInfo) => (props.useItemPath ? item.path : buildItemPath(props.currentPath, item.name));
  const getSelectionKey = (item: FileInfo) => buildSelectionKey(props.baseType, props.baseId, getItemPath(item));
  const [selected, setSelected] = createSignal<Set<SelectionKey>>(new Set(props.initialSelected ?? []));
  const [highlighted, setHighlighted] = createSignal<Set<string>>(new Set());
  const [detailSelectedPath, setDetailSelectedPath] = createSignal<string | null>(props.selectedFilePath ?? null);
  const [lightboxIndex, setLightboxIndex] = createSignal<number | null>(null);
  const [marqueeRect, setMarqueeRect] = createSignal<MarqueeRect | null>(null);
  const [activeContextMenu, setActiveContextMenu] = createSignal<ActiveContextMenu | null>(null);
  let containerRef: HTMLDivElement | undefined;
  const itemRefs = new Map<SelectionKey, HTMLElement>();

  const imageItems = createMemo(() => props.items.filter((item) => item.type === "file" && fileIcons.getFileCategory(item) === "image"));
  const lightboxImages = createMemo<LightboxImage[]>(() =>
    imageItems().map((item) => {
      const itemPath = getItemPath(item);
      const contentUrl = `${fileApiUrl(props.baseType, props.baseId)}/content?path=${encodeURIComponent(itemPath)}`;
      return {
        src: `${contentUrl}&inline=true`,
        alt: item.name,
        downloadUrl: contentUrl,
      };
    }),
  );

  const openLightbox = (imagePath: string) => {
    const idx = imageItems().findIndex((item) => {
      const path = getItemPath(item);
      return path === imagePath || item.name === imagePath;
    });
    if (idx !== -1) setLightboxIndex(idx);
  };

  const buildDetailKey = (itemPath: string) => (props.useFullDetailKey ? `${props.baseType}:${props.baseId}:${itemPath}` : itemPath);

  const selectForDetail = (item: FileInfo) => {
    const itemPath = getItemPath(item);
    setDetailSelectedPath(itemPath);
    setDetailFileInUrl(buildDetailKey(itemPath), item, props.baseType, props.baseId);
  };

  const navigateToFolder = (itemPath: string) => {
    navigateTo(fileAppUrlForPath(props.baseType, props.baseId, itemPath));
  };

  const closeContextMenu = () => setActiveContextMenu(null);

  const openContextMenu = (event: MouseEvent, item: FileInfo, itemPath: string) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveContextMenu({
      x: event.clientX,
      y: event.clientY,
      item,
      itemPath,
    });
  };

  const toggleSelect = (item: FileInfo) => {
    const key = getSelectionKey(item);
    const next = new Set(selected());
    next.has(key) ? next.delete(key) : next.add(key);
    setSelected(next);
    setSelectedInUrl(next);
  };

  const dragMutation = mutations.create<
    { transferred: number; errors: { path: string; error: string }[]; targetPath: string },
    { sourcePaths: string[]; targetPath: string },
    { sourcePaths: string[] }
  >({
    onBefore: (vars) => ({ sourcePaths: vars.sourcePaths }),
    mutation: async ({ sourcePaths, targetPath }) => {
      const res = await apiClient[":baseType"][":baseId"].transfer.$post({
        param: { baseType: props.baseType, baseId: props.baseId },
        json: {
          paths: sourcePaths,
          targetBaseType: props.baseType,
          targetBaseId: props.baseId,
          targetPath,
        },
      });
      if (!res.ok) {
        throw new Error(t().transferFailed);
      }
      const data = (await res.json()) as { transferred: number; errors: { path: string; error: string }[] };
      return { ...data, targetPath };
    },
    onSuccess: (result, ctx) => {
      if (result.errors.length > 0) {
        prompts.error(t().moveFailedSummary({ moved: result.transferred, failed: result.errors.length }));
      } else if (result.transferred > 0) {
        toast.success(t().movedItems({ count: result.transferred }));
      }
      setHighlightedFiles((ctx?.sourcePaths ?? []).map((path) => path.split("/").pop() ?? path));
      clearSelection();
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const fileDnd = dnd.create<DragMeta, DropMeta, null>({
    onDrop: ({ active, over }) => {
      if (!over || dragMutation.loading()) return;
      const activePath = active.meta.itemPath;
      const selectedPaths = [...selected()].map((key) => parseSelectionKey(key)?.path ?? null).filter((path): path is string => !!path);
      const sourcePaths =
        selected().has(buildSelectionKey(props.baseType, props.baseId, activePath)) && selectedPaths.length > 0
          ? selectedPaths
          : [activePath];
      if (sourcePaths.some((path) => path === over.meta.targetPath || getParentPathFromItemPath(path) === over.meta.targetPath)) {
        return;
      }
      dragMutation.mutate({ sourcePaths, targetPath: over.meta.targetPath });
    },
  });

  onMount(() => {
    const highlightedFiles = consumeHighlightedFiles();
    if (highlightedFiles.length > 0) setHighlighted(new Set(highlightedFiles));

    const selectionHandler = (event: Event) => setSelected(new Set((event as CustomEvent<string[]>).detail));
    const detailHandler = (event: Event) => {
      const payload = (event as CustomEvent<DetailFileSelectPayload>).detail;
      if (props.useFullDetailKey) {
        if (payload.baseType === props.baseType && payload.baseId === props.baseId) {
          setDetailSelectedPath(payload.item?.path ?? null);
        } else {
          setDetailSelectedPath(null);
        }
        return;
      }
      setDetailSelectedPath(payload.itemKey);
    };
    const syncDetailFromUrl = () => {
      const key = getDetailFileFromUrl();
      if (!key) {
        setDetailSelectedPath(null);
        return;
      }
      if (!props.useFullDetailKey) {
        setDetailSelectedPath(key);
        return;
      }
      const parsed = parseSelectionKey(key);
      setDetailSelectedPath(parsed?.baseType === props.baseType && parsed.baseId === props.baseId ? parsed.path : null);
    };
    const lightboxHandler = (event: Event) => {
      const payload = (event as CustomEvent<FileLightboxPayload>).detail;
      if (payload.baseType === props.baseType && payload.baseId === props.baseId) openLightbox(payload.path);
    };
    const handleGlobalPointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && target instanceof HTMLElement && target.closest("[data-files-context-menu]")) return;
      closeContextMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };

    window.addEventListener(FILE_SELECTION_EVENT, selectionHandler);
    window.addEventListener(DETAIL_FILE_SELECT_EVENT, detailHandler);
    window.addEventListener("popstate", syncDetailFromUrl);
    window.addEventListener(FILE_LIGHTBOX_EVENT, lightboxHandler);
    document.addEventListener("mousedown", handleGlobalPointer);
    document.addEventListener("keydown", handleEscape);

    let dragStart: { x: number; y: number } | null = null;
    let baseSelection = new Set<SelectionKey>();
    const previousUserSelect = document.body.style.userSelect;

    const onPointerMove = (event: PointerEvent) => {
      if (!dragStart || !containerRef) return;
      const containerRect = containerRef.getBoundingClientRect();
      const left = Math.min(dragStart.x, event.clientX) - containerRect.left;
      const top = Math.min(dragStart.y, event.clientY) - containerRect.top;
      const width = Math.abs(event.clientX - dragStart.x);
      const height = Math.abs(event.clientY - dragStart.y);
      if (width < 4 && height < 4) return;
      const rect = new DOMRect(Math.min(dragStart.x, event.clientX), Math.min(dragStart.y, event.clientY), width, height);
      setMarqueeRect({ left, top, width, height });
      const next = new Set(baseSelection);
      for (const [key, element] of itemRefs.entries()) {
        if (intersects(rect, element.getBoundingClientRect())) next.add(key);
      }
      setSelected(next);
      setSelectedInUrl(next);
    };

    const stopMarquee = () => {
      dragStart = null;
      setMarqueeRect(null);
      document.body.style.userSelect = previousUserSelect;
    };

    const onPointerUp = () => stopMarquee();

    containerRef?.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || isPointerOnInteractiveTarget(event.target)) return;
      if ((event.target as HTMLElement).closest("[data-file-item]")) return;
      dragStart = { x: event.clientX, y: event.clientY };
      baseSelection = new Set();
      document.body.style.userSelect = "none";
      setSelected(baseSelection);
      setSelectedInUrl(baseSelection);
    });

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    onCleanup(() => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener(FILE_SELECTION_EVENT, selectionHandler);
      window.removeEventListener(DETAIL_FILE_SELECT_EVENT, detailHandler);
      window.removeEventListener("popstate", syncDetailFromUrl);
      window.removeEventListener(FILE_LIGHTBOX_EVENT, lightboxHandler);
      document.removeEventListener("mousedown", handleGlobalPointer);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    });
  });

  const sortedItems = createMemo(() => props.items);

  const headerLabel = (column: FileListColumn) => {
    switch (column) {
      case "size":
        return t().size;
      case "mime":
        return t().type;
      case "modified":
        return t().updated;
    }
  };

  return (
    <FileContext.Provider value={contextValue}>
      <div ref={containerRef} class="relative h-full min-h-full select-none">
        <Show
          when={isGrid()}
          fallback={
            <div class="paper overflow-x-auto">
              <div class="grid" style={{ "grid-template-columns": rowTemplate() }}>
                <div class="data-table-header data-table-divider col-span-full grid grid-cols-subgrid items-center gap-4 border-b px-3 py-2 text-xs font-medium text-dimmed">
                  <div>{t().name}</div>
                  <For each={listColumns()}>
                    {(column) => (
                      <div classList={{ "text-left": column === "mime", "text-right": column !== "mime" }}>{headerLabel(column)}</div>
                    )}
                  </For>
                </div>

                <Show when={props.parentPath !== null}>
                  <div class="data-table-row-divider data-table-row-hover col-span-full grid grid-cols-subgrid items-center gap-4 border-b px-3 py-0 text-sm transition-colors">
                    <button
                      type="button"
                      ref={(element) => {
                        fileDnd.droppable(element, () => ({
                          id: `folder:${props.parentPath!}`,
                          disabled: dragMutation.loading(),
                          meta: { targetPath: props.parentPath!, label: ".." },
                        }));
                      }}
                      class="flex min-w-0 items-center gap-3 py-2 text-left"
                      onClick={() => navigateToFolder(props.parentPath!)}
                    >
                      <div class="flex h-10 w-10 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-dimmed">
                        <i class="ti ti-folder-up text-base" />
                      </div>
                      <div class="min-w-0 truncate text-secondary">..</div>
                    </button>
                    <For each={listColumns()}>
                      {(column) => (
                        <div class="text-dimmed" classList={{ "text-left": column === "mime", "text-right": column !== "mime" }}>
                          —
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <For each={sortedItems()}>
                  {(item) => {
                    const itemPath = getItemPath(item);
                    const selectionKey = getSelectionKey(item);
                    return (
                      <FileRow
                        ref={(element) => itemRefs.set(selectionKey, element)}
                        item={item}
                        itemPath={itemPath}
                        ctx={contextValue}
                        columns={listColumns()}
                        compact={isCompactList()}
                        isSelected={!props.hideSelection && selected().has(selectionKey)}
                        selectedCount={selected().size}
                        isHighlighted={highlighted().has(item.name)}
                        isDetailSelected={detailSelectedPath() === itemPath}
                        onToggleSelect={() => toggleSelect(item)}
                        onPrimaryAction={() => (item.type === "directory" ? navigateToFolder(itemPath) : selectForDetail(item))}
                        onSecondaryAction={() => openFileItem({ item, itemPath, ctx: contextValue })}
                        onShowDetail={() => selectForDetail(item)}
                        onContextMenu={(event) => openContextMenu(event, item, itemPath)}
                        hideCheckbox={props.hideSelection}
                        dnd={fileDnd}
                        dragDisabled={dragMutation.loading()}
                      />
                    );
                  }}
                </For>

                <Show when={sortedItems().length === 0 && props.parentPath === null}>
                  <Placeholder
                    icon="ti ti-folder-off"
                    class="col-span-full"
                    description={<>{props.isFiltered ? t().noSearchResults : t().emptyFolder}</>}
                  />
                </Show>
              </div>
            </div>
          }
        >
          <div
            class="grid h-full content-start gap-x-3 gap-y-4"
            style={{
              "grid-template-columns": `repeat(auto-fill, minmax(${gridTileWidth()}px, 1fr))`,
            }}
          >
            <Show when={props.parentPath !== null}>
              <button
                type="button"
                ref={(element) => {
                  fileDnd.droppable(element, () => ({
                    id: `folder:${props.parentPath!}`,
                    disabled: dragMutation.loading(),
                    meta: { targetPath: props.parentPath!, label: ".." },
                  }));
                }}
                class="group flex min-w-0 flex-col items-center gap-2 rounded-[var(--ui-radius-control)] p-2 text-left transition-colors hover:bg-[var(--ui-hover)]"
                onClick={() => navigateToFolder(props.parentPath!)}
              >
                <div class="relative flex w-full justify-center">
                  <div
                    data-dnd-preview
                    class="relative flex items-center justify-center overflow-hidden rounded-lg text-zinc-400"
                    style={{ width: `${gridSize()}px`, height: `${gridSize()}px` }}
                  >
                    <i class="ti ti-folder-up text-4xl" />
                  </div>
                </div>
                <div class="flex w-full items-start gap-1">
                  <span class="min-w-0 flex-1 truncate text-center text-xs leading-tight text-dimmed">..</span>
                </div>
              </button>
            </Show>

            <For each={sortedItems()}>
              {(item) => {
                const itemPath = getItemPath(item);
                const selectionKey = getSelectionKey(item);
                return (
                  <GridTile
                    ref={(element) => itemRefs.set(selectionKey, element)}
                    item={item}
                    itemPath={itemPath}
                    ctx={contextValue}
                    isSelected={!props.hideSelection && selected().has(selectionKey)}
                    selectedCount={selected().size}
                    isHighlighted={highlighted().has(item.name)}
                    isDetailSelected={detailSelectedPath() === itemPath}
                    onToggleSelect={() => toggleSelect(item)}
                    onPrimaryAction={() => (item.type === "directory" ? navigateToFolder(itemPath) : selectForDetail(item))}
                    onSecondaryAction={() => openFileItem({ item, itemPath, ctx: contextValue })}
                    onShowDetail={() => selectForDetail(item)}
                    onContextMenu={(event) => openContextMenu(event, item, itemPath)}
                    hideCheckbox={props.hideSelection}
                    dnd={fileDnd}
                    dragDisabled={dragMutation.loading()}
                  />
                );
              }}
            </For>

            <Show when={sortedItems().length === 0 && props.parentPath === null}>
              <Placeholder
                icon="ti ti-folder-off"
                class="col-span-full"
                description={<>{props.isFiltered ? t().noSearchResults : t().emptyFolder}</>}
              />
            </Show>
          </div>
        </Show>

        <Show when={marqueeRect()}>
          {(rect) => (
            <div
              class="pointer-events-none absolute rounded-[var(--ui-radius-control)] border border-[var(--ui-focus)] bg-[color-mix(in_srgb,var(--ui-focus)_12%,transparent)]"
              style={{
                left: `${rect().left}px`,
                top: `${rect().top}px`,
                width: `${rect().width}px`,
                height: `${rect().height}px`,
              }}
            />
          )}
        </Show>

        <Show when={lightboxIndex() !== null && lightboxImages().length > 0}>
          <Lightbox images={lightboxImages()} initialIndex={lightboxIndex()!} onClose={() => setLightboxIndex(null)} />
        </Show>

        <Show when={activeContextMenu()}>
          {(menu) => (
            <Portal>
              <div
                data-files-context-menu
                role="menu"
                aria-label={t().fileActions}
                class="context-menu-surface fixed z-50 w-52 max-w-[min(22rem,calc(100vw-1rem))] overflow-y-auto p-1 text-zinc-900 backdrop-blur-sm dark:text-zinc-100"
                style={{
                  left: `${Math.min(menu().x, window.innerWidth - 220)}px`,
                  top: `${Math.min(menu().y, window.innerHeight - 320)}px`,
                }}
              >
                {fileActions
                  .buildFileMenuElements({
                    item: menu().item,
                    itemPath: menu().itemPath,
                    ctx: contextValue,
                    onShowDetail: () => selectForDetail(menu().item),
                    onCloseDetail: closeContextMenu,
                  })
                  .map((entry) =>
                    "label" in entry ? (
                      <button
                        type="button"
                        role="menuitem"
                        class={`menu-item text-left ${
                          entry.variant === "danger" ? "text-red-600 dark:text-red-400" : "text-zinc-700 dark:text-zinc-300"
                        }`}
                        onClick={() => {
                          if ("action" in entry && entry.action) {
                            void Promise.resolve(entry.action()).finally(closeContextMenu);
                          } else if ("href" in entry && entry.href) {
                            window.open(entry.href, entry.external ? "_blank" : "_self");
                            closeContextMenu();
                          }
                        }}
                      >
                        {entry.icon && <i class={entry.icon} />}
                        <span>{entry.label}</span>
                      </button>
                    ) : null,
                  )}
              </div>
            </Portal>
          )}
        </Show>
      </div>
    </FileContext.Provider>
  );
}

function GridTile(props: {
  ref?: (element: HTMLDivElement) => void;
  item: FileInfo;
  itemPath: string;
  ctx: FileContextValue;
  isSelected: boolean;
  selectedCount: number;
  isHighlighted: boolean;
  isDetailSelected: boolean;
  onToggleSelect: () => void;
  onPrimaryAction: () => void;
  onSecondaryAction: () => void;
  onShowDetail: () => void;
  onContextMenu: (event: MouseEvent) => void;
  hideCheckbox?: boolean;
  dnd: ReturnType<typeof dnd.create<DragMeta, DropMeta, null>>;
  dragDisabled?: boolean;
}) {
  const size = getGridSizePixels(props.ctx.settings.gridSize);
  const dragId = `file:${props.itemPath}`;
  const isDroppable = props.item.type === "directory";

  return (
    <div
      ref={(element) => {
        props.ref?.(element);
        props.dnd.draggable(element, () => ({
          id: dragId,
          disabled: props.dragDisabled,
          focusable: false,
          keyboard: false,
          meta: { item: props.item, itemPath: props.itemPath },
        }));
        if (isDroppable) {
          props.dnd.droppable(element, () => ({
            id: `folder:${props.itemPath}`,
            disabled: props.dragDisabled,
            meta: {
              targetPath: props.itemPath,
              label: props.item.name,
            },
          }));
        }
      }}
      data-file-item
      class="group flex min-w-0 flex-col items-center gap-2 rounded-[var(--ui-radius-control)] p-2 transition-colors"
      classList={{
        "bg-[var(--ui-selected)] [box-shadow:inset_0_0_0_1px_var(--ui-app-accent-border)]": props.isDetailSelected,
        "bg-[var(--ui-hover)]": props.isHighlighted && !props.isDetailSelected,
        "hover:bg-[var(--ui-hover)]": !props.isHighlighted && !props.isDetailSelected,
      }}
      onClick={(event) => {
        if (isPointerOnInteractiveTarget(event.target)) return;
        props.onPrimaryAction();
      }}
      onDblClick={(event) => {
        if (isPointerOnInteractiveTarget(event.target)) return;
        props.onSecondaryAction();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onPrimaryAction();
        }
      }}
      onContextMenu={props.onContextMenu}
      role="button"
      tabIndex={0}
    >
      <div class="relative flex w-full justify-center">
        <Show when={!props.hideCheckbox}>
          <input
            type="checkbox"
            checked={props.isSelected}
            class="absolute left-1 top-1 z-10 opacity-0 transition-opacity group-hover:opacity-100"
            classList={{ "opacity-100": props.isSelected }}
            data-dnd-ignore
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleSelect();
            }}
          />
        </Show>

        <div
          data-dnd-preview
          data-dnd-count={props.isSelected && props.selectedCount > 1 ? String(props.selectedCount) : undefined}
          class="relative flex items-center justify-center overflow-hidden rounded-lg text-zinc-500"
          style={{ width: `${size}px`, height: `${size}px` }}
        >
          <FilePreview item={props.item} itemPath={props.itemPath} ctx={props.ctx} size={size} />
        </div>
      </div>

      <div class="flex w-full items-start gap-1">
        <span class="min-w-0 flex-1 truncate text-center text-xs leading-tight text-primary" title={props.item.name}>
          {props.item.name}
        </span>
      </div>
    </div>
  );
}

function FileRow(props: {
  ref?: (element: HTMLDivElement) => void;
  item: FileInfo;
  itemPath: string;
  ctx: FileContextValue;
  columns: FileListColumn[];
  compact: boolean;
  isSelected: boolean;
  selectedCount: number;
  isHighlighted: boolean;
  isDetailSelected: boolean;
  onToggleSelect: () => void;
  onPrimaryAction: () => void;
  onSecondaryAction: () => void;
  onShowDetail: () => void;
  onContextMenu: (event: MouseEvent) => void;
  hideCheckbox?: boolean;
  dnd: ReturnType<typeof dnd.create<DragMeta, DropMeta, null>>;
  dragDisabled?: boolean;
}) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const dragId = `file:${props.itemPath}`;
  const previewSize = () => (props.compact ? 30 : 48);
  const mimeLabel = () => (props.item.type === "directory" ? t().folder : props.item.mimeType || t().unknown);
  const categoryLabel = () => {
    if (props.item.type === "directory") return t().folder;
    switch (fileIcons.getFileCategory(props.item)) {
      case "image":
        return t().image;
      case "pdf":
        return t().pdf;
      case "video":
        return t().video;
      case "audio":
        return t().audio;
      case "text":
        return t().textFile;
      case "code":
        return t().sourceCode;
      case "document":
        return t().document;
      case "archive":
        return t().archive;
      default:
        return t().file;
    }
  };

  return (
    <div
      ref={(element) => {
        props.ref?.(element);
        props.dnd.draggable(element, () => ({
          id: dragId,
          disabled: props.dragDisabled,
          focusable: false,
          keyboard: false,
          meta: { item: props.item, itemPath: props.itemPath },
        }));
        if (props.item.type === "directory") {
          props.dnd.droppable(element, () => ({
            id: `folder:${props.itemPath}`,
            disabled: props.dragDisabled,
            meta: {
              targetPath: props.itemPath,
              label: props.item.name,
            },
          }));
        }
      }}
      data-file-item
      class="data-table-row-divider col-span-full grid grid-cols-subgrid items-center gap-4 border-b px-3 py-0 text-sm transition-colors last:border-b-0"
      classList={{
        "data-table-row-selected [box-shadow:inset_3px_0_0_var(--ui-app-accent-border)]": props.isDetailSelected,
        "bg-[var(--ui-hover)]": props.isHighlighted && !props.isDetailSelected,
        "data-table-row-hover": !props.isHighlighted && !props.isDetailSelected,
      }}
      onClick={(event) => {
        if (isPointerOnInteractiveTarget(event.target)) return;
        props.onPrimaryAction();
      }}
      onDblClick={(event) => {
        if (isPointerOnInteractiveTarget(event.target)) return;
        props.onSecondaryAction();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onPrimaryAction();
        }
      }}
      onContextMenu={props.onContextMenu}
      role="button"
      tabIndex={0}
    >
      <div class="flex min-w-0 items-center gap-3" classList={{ "py-1.5": props.compact, "py-2.5": !props.compact }}>
        <Show when={!props.hideCheckbox}>
          <input
            type="checkbox"
            checked={props.isSelected}
            data-dnd-ignore
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleSelect();
            }}
          />
        </Show>
        <div
          data-dnd-preview
          data-dnd-count={props.isSelected && props.selectedCount > 1 ? String(props.selectedCount) : undefined}
          class="relative flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--ui-radius-control)] text-zinc-500"
          style={{ width: `${previewSize()}px`, height: `${previewSize()}px` }}
        >
          <FilePreview item={props.item} itemPath={props.itemPath} ctx={props.ctx} size={previewSize()} mode="list" />
        </div>
        <div class="min-w-0">
          <p class="truncate text-primary" classList={{ "text-[13px]": props.compact, "text-sm": !props.compact }}>
            {props.item.name}
          </p>
          <Show when={!props.compact}>
            <p class="truncate text-xs text-dimmed">{categoryLabel()}</p>
          </Show>
        </div>
      </div>

      <For each={props.columns}>
        {(column) => (
          <div
            class="truncate text-xs text-dimmed"
            classList={{
              "py-1.5": props.compact,
              "py-2.5": !props.compact,
              "justify-self-start text-left": column === "mime",
              "justify-self-end text-right": column !== "mime",
            }}
          >
            {column === "size" && (props.item.type === "directory" ? "—" : text.pprintBytes(props.item.size))}
            {column === "mime" && mimeLabel()}
            {column === "modified" && dates.formatDateTime(props.item.mtime)}
          </div>
        )}
      </For>
    </div>
  );
}

function FilePreview(props: { item: FileInfo; itemPath: string; ctx: FileContextValue; size: number; mode?: "grid" | "list" }) {
  const isImage = () => props.item.type === "file" && fileIcons.getFileCategory(props.item) === "image";
  const icon = () => fileIcons.getFileIcon(props.item);

  return (
    <Show
      when={isImage()}
      fallback={
        <i
          class={`ti ${icon()} ${props.mode === "list" ? (props.size <= 36 ? "text-lg" : "text-xl") : props.size >= 192 ? "text-6xl" : props.size >= 144 ? "text-5xl" : "text-4xl"}`}
        />
      }
    >
      <img
        src={`${fileApiUrl(props.ctx.baseType, props.ctx.baseId)}/thumbnail?path=${encodeURIComponent(props.itemPath)}`}
        alt=""
        class={props.mode === "list" ? "h-full w-full rounded-lg object-cover" : "max-h-full max-w-full rounded-lg object-contain"}
        loading="lazy"
        draggable={false}
      />
    </Show>
  );
}
