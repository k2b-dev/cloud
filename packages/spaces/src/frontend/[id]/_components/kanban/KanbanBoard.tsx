import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { type DateContext, dates } from "@k2b/stdlib";
import {
  type DndBuildIntentContext,
  type DndDraggableSnapshot,
  type DndDroppableSnapshot,
  dnd,
  mutation as mutations,
  query,
} from "@k2b/stdlib/solid";
import { announce, Dropdown, IconButton, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { apiClient } from "@/api/client";
import {
  INACTIVE_ITEM_DAYS,
  type ItemListResult,
  type SpaceColumn,
  type SpaceItem,
  type SpaceItemTemplate,
  type SpaceTag,
  type SpaceVirtualColumnKind,
  type SpaceWormhole,
  type WormholeTransferResult,
} from "@/contracts";
import { descriptionPreview } from "@/presentation/description-preview";
import { isTaskOverdue } from "@/task-overdue";
import { spaceCommandMessages } from "../../../../commands";
import { getDetailItemFromUrl, shouldHandleDetailClick, subscribeToDetailSelection } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import { defaultFilter, type FilterState, hasActiveFilters } from "../filter/types";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import ClaimButton from "../shared/claim/ClaimButton";
import { type ClaimFields, claimTask, releaseTask, resolveCompletionClaim, resolveTransferClaim } from "../shared/claim/claim";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
import { isInactiveTask } from "../shared/item-activity";
import CreateItemButton from "../sidebar/CreateItemButton";
import {
  invalidateSpacesData,
  requestSpacesRouteNavigation,
  subscribeToSpacesDataInvalidation,
  subscribeToSpacesDetailStep,
} from "../workspace/workspace-events";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import { boardVirtualKinds, kanbanBucketFilter } from "./bucket-filter";
import { shouldReloadKanbanColumn } from "./live-scope";
import type { KanbanBucketInitial } from "./types";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates?: SpaceItemTemplate[];
  selectedItemId?: string;
  initialBuckets: KanbanBucketInitial[];
  /** The board filter from the URL, with public IDs; it narrows every column the same way. */
  filter: FilterState;
  /** Column keys this person folded into narrow strips. */
  folded: ReadonlySet<string>;
  onToggleFolded: (bucketKey: string) => void;
  pageSize: number;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
  wormholes: SpaceWormhole[];
};

type DragMeta = {
  itemId: string;
};

type DropMeta =
  | { kind: "item"; bucketKey: string; index: number }
  | { kind: "column"; bucketKey: string }
  | { kind: "wormhole"; wormholeId: string };

type DropIntent =
  | {
      kind: "column";
      bucketKey: string;
      rawInsertIndex: number;
      /** Gap in the rendered column (which still shows the dragged card) where the card lands; null when the drop changes nothing. */
      indicatorIndex: number | null;
    }
  | { kind: "wormhole"; wormholeId: string };

/** Where the card lands, named by the card the user saw next to it; the server picks the rank from the whole column. */
type MovePosition = { afterItemId?: string; beforeItemId?: string };

type MoveContext = {
  previousBuckets: KanbanBucketInitial[];
  /** Set when the card lands in an open status but an automatic column still gathers it: it shows there, with the new status. */
  gatheredBy: SpaceVirtualColumnKind | null;
  targetLabel: string;
  sourceBucketKey: string;
  targetBucketKey: string;
  targetColumnId: string;
  position: MovePosition;
  targetIndex: number;
  /** Sent only when the drop completes or reopens the item; a move that keeps the state needs no claim. */
  completion: ({ completed: boolean } & ClaimFields) | null;
};

/** Where a dragged column header lands: before the board column at this index, or at the end. */
type ColumnIntent = { index: number };

type TransferContext = {
  previousBuckets: KanbanBucketInitial[];
};

/** A column page; the first page of a filtered column also carries the column's unfiltered size. */
type KanbanPage = ItemListResult & { unfilteredTotal?: number };

const boardScrollMemory = new Map<string, { left: number; top: number }>();

/** A finger held this long on a card picks it up. */
const CARD_HOLD_MS = 300;
/** Movement that starts a drag; before the hold it makes the press a swipe that scrolls. */
const CARD_DRAG_DISTANCE = 6;

const virtualColumnIcon = { blocked: "ti-lock", overdue: "ti-alert-triangle" } as const;

const priorityMeta: Record<string, { icon: string; color: string }> = {
  urgent: { icon: "ti-alert-circle", color: "text-red-500" },
  high: { icon: "ti-arrow-up", color: "text-orange-500" },
  medium: { icon: "ti-minus", color: "text-yellow-500" },
  low: { icon: "ti-arrow-down", color: "text-blue-500" },
};

const buildItemUrl = (baseUrl: string, itemId: string) => {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}item=${itemId}`;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Names the loaded card the moved card lands after, or before at the top of a column. The server
 * places it next to that card, so unloaded cards of a paged column cannot tie with or pass it.
 */
const movePosition = (items: SpaceItem[], insertIndex: number): MovePosition => {
  const after = items[insertIndex - 1];
  if (after) return { afterItemId: after.id };
  const before = items[insertIndex];
  return before ? { beforeItemId: before.id } : {};
};

/** Moves a card in or out of a column's counts; a card that matched the filter counts in both. */
const shiftTotals = (bucket: KanbanBucketInitial, delta: number) => ({
  total: Math.max(bucket.total + delta, 0),
  ...(bucket.unfilteredTotal === undefined ? {} : { unfilteredTotal: Math.max(bucket.unfilteredTotal + delta, 0) }),
});

/**
 * Kanban board with SSR-initialized buckets, drag/drop reordering and explicit per-column "load more".
 */
export default function KanbanBoard(props: Props) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
  // The route mounts a new board for every snapshot, so one board keeps one filter for its lifetime.
  const filter = props.filter;
  const filtered = hasActiveFilters(filter);
  const virtualKinds = boardVirtualKinds(props.initialBuckets);
  // All subscribers receive the same invalidation object; each event gets one parallel probe per column.
  const liveProbes = new WeakMap<object, Promise<(boolean | null)[]>>();
  const probeColumns = (invalidation: object, itemId: string) => {
    let probes = liveProbes.get(invalidation);
    if (!probes) {
      probes = Promise.all(
        props.initialBuckets.map(async (bucket) => {
          try {
            const res = await apiClient[":id"].items.filter.$post({
              param: { id: props.spaceId },
              json: {
                ...kanbanBucketFilter({ bucket, virtualKinds, filter: defaultFilter, page: 1, pageSize: 1 }),
                itemIds: [itemId],
              },
            });
            if (!res.ok) return null;
            return (await res.json()).total > 0;
          } catch {
            return null;
          }
        }),
      );
      liveProbes.set(invalidation, probes);
    }
    return probes;
  };
  const bucketQueries = props.initialBuckets.map((initialBucket, bucketIndex) => {
    const source = `${props.spaceId}:${initialBucket.key}`;
    const initialPage: KanbanPage = {
      items: initialBucket.items,
      page: initialBucket.page,
      pageSize: props.pageSize,
      totalPages: initialBucket.totalPages,
      total: initialBucket.total,
      unfilteredTotal: initialBucket.unfilteredTotal,
    };
    const loadColumnPage = async (pageFilter: FilterState, page: number, pageSize: number, abortSignal: AbortSignal) => {
      const res = await apiClient[":id"].items.filter.$post(
        {
          param: { id: props.spaceId },
          json: kanbanBucketFilter({ bucket: initialBucket, virtualKinds, filter: pageFilter, page, pageSize }),
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readResponseError(res, t.loadItemsFailed));
      const result = await res.json();
      if (result.page !== page) throw new Error(t.invalidKanbanPage);
      return result;
    };
    const pages = query.createInfinite<string, KanbanPage, number, { cursor: string | null }>({
      source: () => source,
      initial: { source, pages: [initialPage] },
      loadPage: async (_source, { cursor, abortSignal }) => {
        const page = cursor ?? 1;
        if (!filtered || page > 1) return loadColumnPage(filter, page, props.pageSize, abortSignal);
        const [result, unfiltered] = await Promise.all([
          loadColumnPage(filter, page, props.pageSize, abortSignal),
          loadColumnPage(defaultFilter, 1, 1, abortSignal),
        ]);
        return { ...result, unfilteredTotal: unfiltered.total };
      },
      getNextCursor: (page) => (page.page < page.totalPages ? page.page + 1 : null),
      subscribe: ({ invalidate }) =>
        subscribeToSpacesDataInvalidation(["view"], async (invalidation) => {
          if (invalidation.itemId === null) return invalidate(invalidation);
          const loadedPages = pages.pages();
          const probes = await probeColumns(invalidation, invalidation.itemId);
          if (shouldReloadKanbanColumn({ itemId: invalidation.itemId, pages: loadedPages, probe: probes[bucketIndex] ?? null })) {
            await invalidate(invalidation);
          }
        }),
    });
    return { initialBucket, pages };
  });
  const canonicalBuckets = () =>
    bucketQueries.map(({ initialBucket, pages }) => {
      const pageList = pages.pages();
      const lastPage = pageList.at(-1);
      const seen = new Set<string>();
      const items = pageList
        .flatMap((page) => page.items)
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
      const unfilteredTotal = pageList[0]?.unfilteredTotal ?? initialBucket.unfilteredTotal;
      return {
        ...initialBucket,
        items,
        page: lastPage?.page ?? initialBucket.page,
        totalPages: lastPage?.totalPages ?? initialBucket.totalPages,
        total: lastPage?.total ?? initialBucket.total,
        ...(unfilteredTotal === undefined ? {} : { unfilteredTotal }),
      };
    });
  const [optimisticBuckets, setOptimisticBuckets] = createSignal<KanbanBucketInitial[] | null>(null);
  // A column order this person just chose; the next snapshot mounts a new board with the stored order.
  const [columnOrder, setColumnOrder] = createSignal<string[] | null>(null);
  const inColumnOrder = (list: KanbanBucketInitial[]) => {
    const order = columnOrder();
    return order ? [...list].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : list;
  };
  const buckets = () => inColumnOrder(optimisticBuckets() ?? canonicalBuckets());
  const setBuckets = (update: KanbanBucketInitial[] | ((current: KanbanBucketInitial[]) => KanbanBucketInitial[])) =>
    setOptimisticBuckets((current) => (typeof update === "function" ? update(current ?? canonicalBuckets()) : update));
  const [movingItemId, setMovingItemId] = createSignal<string | null>(null);
  const [selectedItemId, setSelectedItemId] = createSignal<string | null>(props.selectedItemId ?? null);
  let boardScrollContainer: HTMLDivElement | undefined;
  createEffect(() => {
    setSelectedItemId(props.selectedItemId ?? null);
  });

  const getBucketByKey = (bucketKey: string) => buckets().find((bucket) => bucket.key === bucketKey) ?? null;
  /** Writers see the Wormholes section after the last column, one board gap further right. */
  const showWormholes = () => props.canWrite && props.wormholes.length > 0;
  const getWormholeById = (wormholeId: string) => props.wormholes.find((wormhole) => wormhole.id === wormholeId) ?? null;
  const withViewTransition = (update: () => void) => {
    if (typeof document === "undefined") {
      update();
      return;
    }
    const doc = document as Document & {
      startViewTransition?: (callback: () => void) => unknown;
    };
    if (!doc.startViewTransition) {
      update();
      return;
    }
    doc.startViewTransition(() => {
      update();
    });
  };
  const boardScrollKey = () => `spaces-kanban-board-${props.spaceId}`;
  const rememberBoardScroll = () => {
    if (!boardScrollContainer) return;
    boardScrollMemory.set(boardScrollKey(), {
      left: boardScrollContainer.scrollLeft,
      top: boardScrollContainer.scrollTop,
    });
  };
  const restoreBoardScroll = (position = boardScrollMemory.get(boardScrollKey())) => {
    if (!boardScrollContainer || !position) return;
    boardScrollContainer.scrollLeft = position.left;
    boardScrollContainer.scrollTop = position.top;
  };
  const withBoardScrollPreserved = (update: () => void) => {
    const position = {
      left: boardScrollContainer?.scrollLeft ?? 0,
      top: boardScrollContainer?.scrollTop ?? 0,
    };
    boardScrollMemory.set(boardScrollKey(), position);
    update();
    requestAnimationFrame(() => {
      restoreBoardScroll(position);
      requestAnimationFrame(() => restoreBoardScroll(position));
    });
  };
  const resolveTargetColumnId = (bucket: KanbanBucketInitial) => {
    return bucket.columnId;
  };

  const findItemLocation = (itemId: string) => {
    for (const bucket of buckets()) {
      const index = bucket.items.findIndex((item) => item.id === itemId);
      if (index >= 0) {
        return {
          bucket,
          index,
          item: bucket.items[index]!,
        };
      }
    }
    return null;
  };

  const resolveMoveTargets = (params: { itemId: string; bucketKey: string }) => {
    const source = findItemLocation(params.itemId);
    const targetBucket = getBucketByKey(params.bucketKey);
    if (!source || !targetBucket) {
      return null;
    }
    return { source, targetBucket };
  };

  const normalizeTargetIndex = (params: {
    sourceBucketKey: string;
    sourceIndex: number;
    targetBucketKey: string;
    targetBucketLength: number;
    rawIndex: number;
  }) => {
    let targetIndex = clamp(params.rawIndex, 0, params.targetBucketLength);
    if (params.sourceBucketKey === params.targetBucketKey && params.sourceIndex < targetIndex) {
      targetIndex -= 1;
    }
    const maxIndex =
      params.sourceBucketKey === params.targetBucketKey ? Math.max(0, params.targetBucketLength - 1) : params.targetBucketLength;
    return clamp(targetIndex, 0, maxIndex);
  };

  const isNoOpMove = (itemId: string, intent: DropIntent) => {
    if (intent.kind !== "column") return false;
    const resolved = resolveMoveTargets({ itemId, bucketKey: intent.bucketKey });
    if (!resolved) return true;
    const targetIndex = normalizeTargetIndex({
      sourceBucketKey: resolved.source.bucket.key,
      sourceIndex: resolved.source.index,
      targetBucketKey: resolved.targetBucket.key,
      targetBucketLength: resolved.targetBucket.items.length,
      rawIndex: intent.rawInsertIndex,
    });
    return resolved.source.bucket.key === resolved.targetBucket.key && resolved.source.index === targetIndex;
  };

  const buildDropIntent = (ctx: DndBuildIntentContext<DragMeta, DropMeta, DropIntent>) => {
    if (!ctx.over) return null;

    if (ctx.over.meta.kind === "wormhole") {
      const source = findItemLocation(ctx.active.meta.itemId);
      if (!source || !canTransferThroughWormhole(source.item)) return null;
      return { kind: "wormhole" as const, wormholeId: ctx.over.meta.wormholeId };
    }

    let rawIndex: number;
    if (ctx.over.meta.kind === "item") {
      rawIndex = ctx.pointer.y <= ctx.over.rect.top + ctx.over.rect.height / 2 ? ctx.over.meta.index : ctx.over.meta.index + 1;
    } else {
      // Pointer is somewhere in the column body; locate insert index from card rects.
      const cards = ctx.over.element.querySelectorAll<HTMLElement>("[data-card-index]");
      rawIndex = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i]!.getBoundingClientRect();
        if (ctx.pointer.y < r.top + r.height / 2) {
          rawIndex = i;
          break;
        }
      }
    }

    return columnDropIntent(ctx.active.meta.itemId, ctx.over.meta.bucketKey, rawIndex);
  };

  /** A card dropped into the gap at `rawIndex` of a column, by the same rules for the pointer and the keyboard. */
  const columnDropIntent = (itemId: string, bucketKey: string, rawIndex: number): DropIntent | null => {
    const resolved = resolveMoveTargets({ itemId, bucketKey });
    if (!resolved) return null;

    if (!resolveTargetColumnId(resolved.targetBucket)) {
      return null;
    }
    // A card from an automatic column over the open status it already has would change nothing.
    if (
      resolved.source.bucket.kind !== "column" &&
      !resolved.targetBucket.isDone &&
      resolved.source.item.columnId === resolved.targetBucket.columnId
    ) {
      return null;
    }

    const targetIndex = normalizeTargetIndex({
      sourceBucketKey: resolved.source.bucket.key,
      sourceIndex: resolved.source.index,
      targetBucketKey: resolved.targetBucket.key,
      targetBucketLength: resolved.targetBucket.items.length,
      rawIndex,
    });
    const unchanged = resolved.source.bucket.key === resolved.targetBucket.key && resolved.source.index === targetIndex;

    return {
      kind: "column" as const,
      bucketKey: resolved.targetBucket.key,
      rawInsertIndex: rawIndex,
      indicatorIndex: unchanged ? null : clamp(rawIndex, 0, resolved.targetBucket.items.length),
    };
  };

  const describeDroppable = (over: DndDroppableSnapshot<DropMeta> | null) => {
    if (!over) return t.noTarget;
    if (over.meta.kind === "wormhole") {
      const target = getWormholeById(over.meta.wormholeId)?.target;
      return target ? t.wormholeTarget({ space: target.spaceName, column: target.columnName }) : t.unavailableWormhole;
    }
    const bucket = getBucketByKey(over.meta.bucketKey);
    if (!bucket) return t.unknownTarget;
    return bucket.kind === "column" ? t.columnTarget({ column: bucket.label }) : t.virtualColumnTarget({ column: bucket.label });
  };

  const describeActiveItem = (active: DndDraggableSnapshot<DragMeta>) => {
    const location = findItemLocation(active.meta.itemId);
    return location?.item.title ?? t.genericItem;
  };

  /** The automatic column under a dragged card that came from elsewhere: it takes no drop and says so. */
  const refusingBucket = (itemId: string, over: DndDroppableSnapshot<DropMeta> | null) => {
    if (!over || over.meta.kind === "wormhole") return null;
    const bucket = getBucketByKey(over.meta.bucketKey);
    if (!bucket || bucket.kind === "column") return null;
    return findItemLocation(itemId)?.bucket.key === bucket.key ? null : bucket;
  };
  const [refusingBucketKey, setRefusingBucketKey] = createSignal<string | null>(null);
  // The controller clears its intent before it announces a drop, so the board keeps the last one.
  let cardIntent: DropIntent | null = null;
  const boardDnd = dnd.create<DragMeta, DropMeta, DropIntent>({
    activationDistance: CARD_DRAG_DISTANCE,
    buildIntent: buildDropIntent,
    onDragStart: () => {
      cardIntent = null;
      cancelKeyboardMove();
    },
    onDragOver: ({ active, over, intent }) => {
      cardIntent = intent;
      setRefusingBucketKey(refusingBucket(active.meta.itemId, over)?.key ?? null);
    },
    onCancel: () => setRefusingBucketKey(null),
    announcements: {
      dragStart: (active) => t.dragPickedUp({ item: describeActiveItem(active) }),
      dragOver: (_active, over) => describeDroppable(over),
      drop: (active, over) => {
        const item = describeActiveItem(active);
        if (cardIntent && !isNoOpMove(active.meta.itemId, cardIntent)) return t.dragDropped({ item, target: describeDroppable(over) });
        const refusing = refusingBucket(active.meta.itemId, over);
        return refusing ? t.dragRefused({ item, column: refusing.label }) : t.dragNotMoved({ item });
      },
      cancel: (active) => t.dragCancelled({ item: describeActiveItem(active) }),
    },
    onDrop: ({ active, intent }) => {
      setRefusingBucketKey(null);
      if (!intent || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
      if (intent.kind === "wormhole") {
        void dropOnWormhole(active.meta.itemId, intent.wormholeId);
        return;
      }
      if (isNoOpMove(active.meta.itemId, intent)) return;
      void dropCard(active.meta.itemId, intent);
    },
  });

  onMount(() => {
    onCleanup(subscribeToSpacesDetailStep(kanbanCards, (card) => setSelectedItemId(card.dataset.itemId ?? null)));
    requestAnimationFrame(() => restoreBoardScroll());
    boardScrollContainer?.addEventListener("scroll", rememberBoardScroll, { passive: true });
    setSelectedItemId(getDetailItemFromUrl());
    const unsubscribe = subscribeToDetailSelection(({ itemId }) => {
      setSelectedItemId(itemId);
    });
    onCleanup(() => {
      boardScrollContainer?.removeEventListener("scroll", rememberBoardScroll);
      unsubscribe();
    });
  });

  /** Reconciles after a confirmed write; a failed refresh says the change was saved and retries the refresh. */
  const refreshBoard = (failure: string): void =>
    void invalidateSpacesData(["view"]).catch(() => retryToast(failure, t.retry, () => refreshBoard(failure)));
  const refreshWorkspace = (failure: string): void =>
    void invalidateSpacesData().catch(() => retryToast(failure, t.retry, () => refreshWorkspace(failure)));

  // ---- Column order: people who may change the statuses reorder the board for everyone. ----
  const [columnAnnouncement, setColumnAnnouncement] = createSignal("");
  type ColumnMove = { keys: string[]; movedKey: string };
  const reorderColumnsMutation = mutations.create<void, ColumnMove, ColumnMove & { previous: string[] | null }>({
    onBefore: (move) => {
      const previous = columnOrder();
      setColumnOrder(move.keys);
      return { ...move, previous };
    },
    mutation: async ({ keys }) => {
      const columnIds = keys.map((key) => {
        const bucket = getBucketByKey(key)!;
        return bucket.kind === "column" ? bucket.columnId! : bucket.kind;
      });
      const response = await apiClient[":id"].columns.order.$put({ param: { id: props.spaceId }, json: { columnIds } });
      if (!response.ok) throw new Error(await readResponseError(response, t.reorderStatusesFailed));
    },
    onSuccess: (_result, context) => {
      const bucket = context && getBucketByKey(context.movedKey);
      if (!context || !bucket) return;
      setColumnAnnouncement(
        t.columnMoved({ column: bucket.label, position: context.keys.indexOf(context.movedKey) + 1, count: context.keys.length }),
      );
    },
    onError: (error, context) => {
      setColumnOrder(context?.previous ?? null);
      toast.error(error.message);
    },
  });
  /** Moves a column so it sits before the column now at `insertIndex`, or last. */
  const moveColumn = (key: string, insertIndex: number) => {
    if (!props.canWrite || reorderColumnsMutation.loading()) return;
    const keys = buckets().map((bucket) => bucket.key);
    const from = keys.indexOf(key);
    const to = insertIndex > from ? insertIndex - 1 : insertIndex;
    if (from < 0 || to === from || to < 0 || to >= keys.length) return;
    keys.splice(from, 1);
    keys.splice(to, 0, key);
    void reorderColumnsMutation.mutate({ keys, movedKey: key });
  };
  const bucketLabel = (key: string) => getBucketByKey(key)?.label ?? t.unknownTarget;
  // As for cards: the intent is already cleared when the controller announces the drop.
  let columnIntent: ColumnIntent | null = null;
  const columnDnd = dnd.create<{ bucketKey: string }, { bucketKey: string }, ColumnIntent>({
    isSameIntent: (a, b) => a?.index === b?.index,
    onDragStart: () => {
      columnIntent = null;
    },
    onDragOver: ({ intent }) => {
      columnIntent = intent;
    },
    buildIntent: ({ active, over, pointer }) => {
      if (!over) return null;
      const keys = buckets().map((bucket) => bucket.key);
      const overIndex = keys.indexOf(over.meta.bucketKey);
      const index = pointer.x < over.rect.left + over.rect.width / 2 ? overIndex : overIndex + 1;
      const from = keys.indexOf(active.meta.bucketKey);
      return overIndex < 0 || index === from || index === from + 1 ? null : { index };
    },
    announcements: {
      dragStart: (active) => t.columnPickedUp({ column: bucketLabel(active.meta.bucketKey) }),
      dragOver: (_active, over) => (over ? t.columnTarget({ column: bucketLabel(over.meta.bucketKey) }) : t.noTarget),
      // A real move is announced once it is saved.
      drop: (active): string => (columnIntent ? "" : t.columnMoveCancelled({ column: bucketLabel(active.meta.bucketKey) })),
      cancel: (active) => t.columnMoveCancelled({ column: bucketLabel(active.meta.bucketKey) }),
    },
    onDrop: ({ active, intent }) => {
      if (intent) moveColumn(active.meta.bucketKey, intent.index);
    },
  });
  const columnIndicatorIndex = () => (columnDnd.isDragging() ? (columnDnd.intent()?.index ?? null) : null);
  const focusColumnMenu = (key: string) =>
    requestAnimationFrame(() =>
      boardScrollContainer
        ?.querySelector<HTMLElement>(`[data-spaces-kanban-column-menu="${CSS.escape(key)}"]`)
        ?.focus({ preventScroll: true }),
    );

  /** The automatic column that shows an item on this board, by the server's rule: Blocked first, then Overdue. */
  const gatheringKind = (item: SpaceItem): SpaceVirtualColumnKind | null => {
    if (item.completedAt) return null;
    if (virtualKinds.has("blocked") && item.activeBlockerCount > 0) return "blocked";
    return virtualKinds.has("overdue") && isTaskOverdue(item, props.dateConfig) ? "overdue" : null;
  };
  /** Where a card with this status joins an automatic column, which lists its tasks in status order. */
  const gatheredIndex = (bucket: KanbanBucketInitial, columnId: string) => {
    const statusIndex = (id: string) => props.columns.findIndex((column) => column.id === id);
    const status = statusIndex(columnId);
    const next = bucket.items.findIndex((item) => statusIndex(item.columnId) > status);
    return next < 0 ? bucket.items.length : next;
  };

  const moveMutation = mutations.create<SpaceItem, { itemId: string; intent: DropIntent; claim: ClaimFields }, MoveContext>({
    onBefore: ({ itemId, intent, claim }) => {
      if (intent.kind !== "column") throw new Error(t.invalidColumnTarget);
      const previousBuckets = buckets();
      const resolved = resolveMoveTargets({
        itemId,
        bucketKey: intent.bucketKey,
      });
      if (!resolved) throw new Error(t.unresolvedDropTarget);

      const targetIndex = normalizeTargetIndex({
        sourceBucketKey: resolved.source.bucket.key,
        sourceIndex: resolved.source.index,
        targetBucketKey: resolved.targetBucket.key,
        targetBucketLength: resolved.targetBucket.items.length,
        rawIndex: intent.rawInsertIndex,
      });

      const targetColumnId = resolveTargetColumnId(resolved.targetBucket);
      if (!targetColumnId) {
        throw new Error(t.targetColumnUnavailable);
      }

      const targetItemsWithoutSource = resolved.targetBucket.items.filter((item) => item.id !== itemId);
      const targetIndexClamped = clamp(targetIndex, 0, targetItemsWithoutSource.length);
      const changesCompletion = resolved.targetBucket.isDone !== Boolean(resolved.source.item.completedAt);
      const optimisticUpdated: SpaceItem = {
        ...resolved.source.item,
        columnId: targetColumnId,
        completedAt: changesCompletion
          ? resolved.targetBucket.isDone
            ? new Date().toISOString()
            : null
          : resolved.source.item.completedAt,
      };
      // Only completion ends blocked or overdue, so a card that lands in an open status shows under the
      // automatic column that still gathers it: one dragged out of it stays in place, one reopened from a
      // done status goes there.
      const sourceBucket = resolved.source.bucket;
      const gatheredBy = gatheringKind(optimisticUpdated);
      const landing = (gatheredBy && buckets().find((bucket) => bucket.kind === gatheredBy)) || resolved.targetBucket;
      const landingIndex =
        landing.key === resolved.targetBucket.key
          ? targetIndexClamped
          : landing.key === sourceBucket.key
            ? resolved.source.index
            : gatheredIndex(landing, targetColumnId);

      withBoardScrollPreserved(() => {
        withViewTransition(() => {
          setBuckets((current) =>
            current.map((bucket) => {
              const hadItem = bucket.items.some((item) => item.id === itemId);
              const nextItems = bucket.items.filter((item) => item.id !== itemId);
              let delta = hadItem ? -1 : 0;

              if (bucket.key === landing.key) {
                nextItems.splice(landingIndex, 0, optimisticUpdated);
                delta += 1;
              }

              return { ...bucket, items: nextItems, ...shiftTotals(bucket, delta) };
            }),
          );
        });
      });

      setMovingItemId(itemId);
      return {
        previousBuckets,
        gatheredBy: landing.key === resolved.targetBucket.key ? null : gatheredBy,
        targetLabel: resolved.targetBucket.label,
        sourceBucketKey: sourceBucket.key,
        targetBucketKey: landing.key,
        targetColumnId,
        // A folded column shows no cards to land next to; without a position the server puts the card at
        // the top of the whole column, above cards an active filter hides.
        position: props.folded.has(resolved.targetBucket.key) ? {} : movePosition(targetItemsWithoutSource, targetIndexClamped),
        targetIndex: landingIndex,
        completion: changesCompletion ? { completed: resolved.targetBucket.isDone, ...claim } : null,
      };
    },
    mutation: async (vars, ctx) => {
      const moveRes = await apiClient[":id"].items[":itemId"].move.$post({
        param: { id: props.spaceId, itemId: vars.itemId },
        json: { columnId: ctx.targetColumnId, ...ctx.position, ...ctx.completion },
      });
      if (!moveRes.ok) {
        throw new Error(await readResponseError(moveRes, t.moveFailed));
      }
      return (await moveRes.json()) as SpaceItem;
    },
    onSuccess: (updated, ctx) => {
      withBoardScrollPreserved(() => {
        withViewTransition(() => {
          setBuckets((current) =>
            current.map((bucket) => {
              const hadItem = bucket.items.some((item) => item.id === updated.id);
              const nextItems = bucket.items.filter((item) => item.id !== updated.id);
              let delta = hadItem ? -1 : 0;

              if (bucket.key === ctx?.targetBucketKey) {
                const insertIndex = clamp(ctx.targetIndex, 0, nextItems.length);
                nextItems.splice(insertIndex, 0, updated);
                delta += 1;
              }

              return { ...bucket, items: nextItems, ...shiftTotals(bucket, delta) };
            }),
          );
        });
      });
      if (ctx?.gatheredBy) {
        toast(
          ctx.gatheredBy === "blocked"
            ? t.movedStaysBlocked({ status: ctx.targetLabel })
            : t.movedStaysOverdue({ status: ctx.targetLabel }),
        );
      }
      refreshBoard(t.moveRefreshFailed);
    },
    onError: (error, ctx) => {
      if (ctx) {
        // Show the columns Spaces holds rather than the board from before the drop: that board can
        // still show a neighbor someone else moved or deleted, and every retry would name it again.
        // The refresh is best effort; the failed move is the error to report.
        withBoardScrollPreserved(() => {
          withViewTransition(() => {
            setOptimisticBuckets(null);
          });
        });
        void invalidateSpacesData(["view"]).catch(() => undefined);
      }
      toast.error(error.message);
    },
    onAbort: (ctx) => {
      if (ctx?.previousBuckets) setBuckets(ctx.previousBuckets);
    },
    onFinally: () => setMovingItemId(null),
  });

  /**
   * A drop that completes or reopens a task someone else claimed asks once to take the claim over. Declining leaves the
   * card where it was, as after any drop that changes nothing: the board only moves it once the move is under way.
   */
  const dropCard = async (itemId: string, intent: DropIntent, onMove?: () => void) => {
    const resolved = intent.kind === "column" ? resolveMoveTargets({ itemId, bucketKey: intent.bucketKey }) : null;
    const completed = resolved?.targetBucket.isDone ?? false;
    const claim =
      resolved && completed !== Boolean(resolved.source.item.completedAt)
        ? await resolveCompletionClaim(resolved.source.item.claim, props.currentUserId, completed, t)
        : {};
    if (!claim || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
    onMove?.();
    await moveMutation.mutate({ itemId, intent, claim });
  };

  /** A transfer ends the claim: the holder's own ends without a question, someone else's is taken over after one. */
  const dropOnWormhole = async (itemId: string, wormholeId: string) => {
    const claim = await resolveTransferClaim(findItemLocation(itemId)?.item.claim, props.currentUserId, t);
    if (!claim || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
    await transferMutation.mutate({ itemId, wormholeId, claim });
  };

  // ---- Touch pick-up: a finger held on a card's body lifts it, as on iPadOS; one that moves first scrolls the board.
  // The board owns the hold: dnd's touch delay is one for the whole controller, so the grip would wait as long, and dnd
  // starts a drag only on movement, which the browser would already take for a scroll. A mouse or pen keeps to the
  // grip, because dnd captures the pointer at the press, and a click on the card would then no longer open it.
  const cardDragDisabled = () => !props.canWrite || moveMutation.loading() || transferMutation.loading();
  const [heldItemId, setHeldItemId] = createSignal<string | null>(null);
  onMount(() => {
    const board = boardScrollContainer;
    if (!board) return;
    let press: {
      pointerId: number;
      itemId: string;
      link: HTMLAnchorElement;
      startX: number;
      startY: number;
      held: boolean;
    } | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressNextClick = false;
    const endPress = () => {
      if (press?.held) suppressNextClick = true;
      clearTimeout(holdTimer);
      press?.link.removeAttribute("data-spaces-kanban-touch-press");
      press = null;
      setHeldItemId(null);
      window.removeEventListener("pointermove", movePress, true);
      window.removeEventListener("pointerup", releasePress, true);
      window.removeEventListener("pointercancel", releasePress, true);
    };
    const movePress = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId || press.held) return;
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < CARD_DRAG_DISTANCE) return;
      endPress();
      // Clear stdlib's pending press before its shorter touch delay can turn a swipe into a drag.
      if (!boardDnd.isDragging()) boardDnd.cancel();
    };
    const releasePress = (event: PointerEvent) => {
      if (event.pointerId === press?.pointerId) endPress();
    };
    const startPress = (event: PointerEvent) => {
      suppressNextClick = false;
      if (event.pointerType !== "touch" || !event.isPrimary || event.button !== 0 || cardDragDisabled() || boardDnd.isDragging()) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("[data-spaces-kanban-card]") : null;
      const itemId = link?.dataset.itemId;
      if (!link || !board.contains(link) || !itemId) return;
      endPress();
      link.setAttribute("data-spaces-kanban-touch-press", "");
      press = { pointerId: event.pointerId, itemId, link, startX: event.clientX, startY: event.clientY, held: false };
      holdTimer = setTimeout(() => {
        if (!press) return;
        press.held = true;
        setHeldItemId(press.itemId);
      }, CARD_HOLD_MS);
      window.addEventListener("pointermove", movePress, true);
      window.addEventListener("pointerup", releasePress, true);
      window.addEventListener("pointercancel", releasePress, true);
    };
    const preventHeldScroll = (event: TouchEvent) => {
      if (press?.held) event.preventDefault();
    };
    const suppressHeldClick = (event: MouseEvent) => {
      if (!suppressNextClick || event.detail === 0) return;
      event.preventDefault();
      event.stopPropagation();
      suppressNextClick = false;
    };
    const preventTouchMenu = (event: MouseEvent) => {
      if (press) event.preventDefault();
    };
    board.addEventListener("pointerdown", startPress, true);
    // This must exist before the press, when the browser decides whether the gesture may scroll.
    board.addEventListener("touchmove", preventHeldScroll, { passive: false });
    board.addEventListener("click", suppressHeldClick, true);
    board.addEventListener("contextmenu", preventTouchMenu, true);
    onCleanup(() => {
      endPress();
      board.removeEventListener("pointerdown", startPress, true);
      board.removeEventListener("touchmove", preventHeldScroll);
      board.removeEventListener("click", suppressHeldClick, true);
      board.removeEventListener("contextmenu", preventTouchMenu, true);
    });
  });

  // ---- Keyboard move: Space or Enter on a grip picks the card up, the arrow keys move its slot, and the drop goes
  // through the pointer's rules. The board owns it, because the dnd keyboard mode steps through every card on the board.
  /** A card picked up from its grip, and the slot it would take: `position` is its index there once it has moved. */
  type KeyboardMove = { itemId: string; title: string; bucketKey: string; position: number };
  const [keyboardMove, setKeyboardMove] = createSignal<KeyboardMove | null>(null);
  /**
   * A keyboard drop draws the columns again, so the grip it started from is gone. The card's new grip takes over the
   * focus, or, when the card went into a folded column that shows no cards, that column's strip. The person's next
   * focus change or click ends this, so a later redraw never pulls the focus back.
   */
  let dropFocus: { itemId: string; bucketKey: string } | null = null;
  const isDropFocusTarget = (element: Element, focus: { itemId: string; bucketKey: string }) =>
    element.closest<HTMLElement>("[data-spaces-kanban-grip]")?.dataset.spacesKanbanGrip === focus.itemId ||
    element.closest<HTMLElement>("[data-spaces-kanban-fold]")?.dataset.spacesKanbanFold === focus.bucketKey;
  const restoreDropFocus = (element: HTMLElement, owns: (focus: { itemId: string; bucketKey: string }) => boolean) => {
    const focus = dropFocus;
    if (!focus) return;
    queueMicrotask(() => {
      // Only while focus fell to the page because the dropped card was drawn again.
      const focusLost = !document.activeElement || document.activeElement === document.body;
      if (dropFocus !== focus || !element.isConnected || !focusLost || !owns(focus)) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };
  onMount(() => {
    const endDropFocus = () => {
      dropFocus = null;
    };
    document.addEventListener("pointerdown", endDropFocus, true);
    onCleanup(() => document.removeEventListener("pointerdown", endDropFocus, true));
  });
  /** The slots a column offers the card: one more than its cards, unless the card already counts among them. */
  const slotCount = (move: KeyboardMove, bucket: KanbanBucketInitial) =>
    bucket.items.length + (bucket.items.some((item) => item.id === move.itemId) ? 0 : 1);
  /** A folded column shows no cards to land between, so it takes the card at the top. */
  const lastPosition = (move: KeyboardMove, bucket: KanbanBucketInitial) =>
    props.folded.has(bucket.key) ? 0 : slotCount(move, bucket) - 1;
  const keyboardIntent = (move: KeyboardMove) => {
    const source = findItemLocation(move.itemId);
    if (!source) return null;
    // The column still shows the card in its old place, so a slot below that place is one gap further down.
    const rawIndex = source.bucket.key === move.bucketKey && move.position > source.index ? move.position + 1 : move.position;
    return columnDropIntent(move.itemId, move.bucketKey, rawIndex);
  };
  /** Where a pointer or keyboard drag would drop the card now; the drop line and the target column show it. Every drop line reads it. */
  const cardDropIntent = createMemo(() => {
    const move = keyboardMove();
    if (move) return keyboardIntent(move);
    return boardDnd.isDragging() ? boardDnd.intent() : null;
  });
  const showKeyboardMove = (move: KeyboardMove) => {
    setKeyboardMove(move);
    const bucket = getBucketByKey(move.bucketKey);
    if (bucket) announce(t.dragPosition({ column: bucket.label, position: move.position + 1, count: lastPosition(move, bucket) + 1 }));
    requestAnimationFrame(() =>
      (
        boardScrollContainer?.querySelector("[data-spaces-kanban-drop-indicator]") ??
        boardScrollContainer?.querySelector(`[data-spaces-kanban-column="${CSS.escape(move.bucketKey)}"]`)
      )?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    );
  };
  const cancelKeyboardMove = () => {
    const move = keyboardMove();
    if (!move) return;
    setKeyboardMove(null);
    announce(t.dragCancelled({ item: move.title }));
  };
  // Changed columns, from a refresh or a card that left the board, take the slot's meaning away.
  createEffect(on(buckets, () => untrack(cancelKeyboardMove), { defer: true }));
  const dropKeyboardMove = (move: KeyboardMove) => {
    setKeyboardMove(null);
    const intent = keyboardIntent(move);
    const bucket = getBucketByKey(move.bucketKey);
    if (!intent || !bucket || isNoOpMove(move.itemId, intent)) {
      announce(t.dragNotMoved({ item: move.title }));
      return;
    }
    announce(t.dragDropped({ item: move.title, target: t.columnTarget({ column: bucket.label }) }));
    // Set once the claim question, if any, is answered: a click in it must not end the restore.
    void dropCard(move.itemId, intent, () => {
      dropFocus = { itemId: move.itemId, bucketKey: move.bucketKey };
    });
  };
  const handleGripKeyDown = (event: KeyboardEvent, itemId: string) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const move = keyboardMove();
    const grab = event.key === " " || event.key === "Enter";
    if (!move) {
      if (!grab || event.repeat || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
      const source = findItemLocation(itemId);
      if (!source) return;
      event.preventDefault();
      event.stopPropagation();
      dropFocus = null;
      announce(t.dragPickedUp({ item: source.item.title }));
      showKeyboardMove({ itemId, title: source.item.title, bucketKey: source.bucket.key, position: source.index });
      return;
    }
    if (event.key === "Escape" || grab) {
      // Handled here, so the workspace does not close the detail panel and the grip is not clicked.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") cancelKeyboardMove();
      else if (!event.repeat) dropKeyboardMove(move);
      return;
    }
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!vertical && event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      // Single-key shortcuts such as J and K, which step the detail panel, wait until the card is dropped.
      if (event.key.length === 1) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const list = buckets();
    const current = list.find((bucket) => bucket.key === move.bucketKey);
    if (!current) return;
    if (vertical) {
      // An automatic column orders its cards itself; the card stays where it is and says so again.
      if (current.kind !== "column") {
        showKeyboardMove(move);
        return;
      }
      const position = clamp(move.position + (event.key === "ArrowUp" ? -1 : 1), 0, lastPosition(move, current));
      showKeyboardMove({ ...move, position });
      return;
    }
    // Automatic columns take no card from elsewhere, so the slot passes them.
    const offset = event.key === "ArrowLeft" ? -1 : 1;
    let index = list.indexOf(current) + offset;
    while (list[index] && list[index]!.kind !== "column") index += offset;
    const target = list[index];
    if (!target) {
      showKeyboardMove(move);
      return;
    }
    const next = { ...move, bucketKey: target.key };
    showKeyboardMove({ ...next, position: clamp(move.position, 0, lastPosition(next, target)) });
  };

  type Transfer = { itemId: string; wormholeId: string; claim: ClaimFields };
  const transferMutation = mutations.create<WormholeTransferResult, Transfer, TransferContext>({
    onBefore: ({ itemId }) => {
      const source = findItemLocation(itemId);
      if (!source) throw new Error(t.itemUnavailable);
      if (!canTransferThroughWormhole(source.item)) throw new Error(t.recurringWormholeBlocked);
      const previousBuckets = buckets();

      withBoardScrollPreserved(() => {
        withViewTransition(() => {
          setBuckets((current) =>
            current.map((bucket) => {
              const hadItem = bucket.items.some((item) => item.id === itemId);
              return hadItem ? { ...bucket, items: bucket.items.filter((item) => item.id !== itemId), ...shiftTotals(bucket, -1) } : bucket;
            }),
          );
        });
      });
      setMovingItemId(itemId);
      return { previousBuckets };
    },
    mutation: (vars, context) =>
      transferThroughWormhole({
        sourceSpaceId: props.spaceId,
        itemId: vars.itemId,
        wormholeId: vars.wormholeId,
        claim: vars.claim,
        signal: context.abortSignal,
        locale: locale(),
      }),
    onSuccess: (result) => {
      showWormholeTransferToast(result, locale());
      refreshBoard(t.transferRefreshFailed);
      if (selectedItemId() === result.item.id) {
        requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
      }
    },
    onError: (error, context) => {
      if (context?.previousBuckets) {
        withBoardScrollPreserved(() => {
          withViewTransition(() => setBuckets(context.previousBuckets));
        });
      }
      if (error.name !== "AbortError") toast.error(error.message);
    },
    onAbort: (context) => {
      if (context?.previousBuckets) setBuckets(context.previousBuckets);
    },
    onFinally: () => setMovingItemId(null),
  });

  const currentCard = (item: SpaceItem): SpaceItem => findItemLocation(item.id)?.item ?? item;
  const assignCardMutation = mutations.create<SpaceItem, SpaceItem, { item: SpaceItem }>({
    onBefore: (item) => ({ item }),
    mutation: async (item) => {
      if (item.assignees?.some((assignee) => assignee.id === props.currentUserId)) return item;
      const response = await apiClient[":id"].items[":itemId"].$patch({
        param: { id: props.spaceId, itemId: item.id },
        json: { assigneeIds: [...(item.assignees?.map((assignee) => assignee.id) ?? []), props.currentUserId] },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.assignToMeFailed));
      return response.json();
    },
    onSuccess: (item) => {
      const alreadyAssigned = findItemLocation(item.id)?.item.assignees?.some((assignee) => assignee.id === props.currentUserId);
      setBuckets((current) =>
        current.map((bucket) => ({ ...bucket, items: bucket.items.map((candidate) => (candidate.id === item.id ? item : candidate)) })),
      );
      const refocus = () => focusCard(kanbanCards().find((card) => card.dataset.itemId === item.id));
      queueMicrotask(refocus);
      // The card shows the new avatar; only an assignment that changed nothing needs a visible message. The command
      // came from a shortcut or the palette, so a screen reader is told what the card now shows.
      if (alreadyAssigned) {
        toast(t.alreadyAssignedToYou);
        return;
      }
      announce(t.assignedToYou);
      const refresh = (): void =>
        void invalidateSpacesData()
          .then(refocus)
          .catch(() => retryToast(t.itemRefreshFailed, t.retry, refresh));
      refresh();
    },
    // Retry starts from the card as the board shows it now, so it cannot drop an assignee added in the meantime.
    onError: (error, context) => retryToast(error.message, t.retry, () => context && assignCardMutation.mutate(currentCard(context.item))),
  });

  type CardCompletion = { item: SpaceItem; claim: ClaimFields };
  const completeCardMutation = mutations.create<SpaceItem, CardCompletion, CardCompletion>({
    onBefore: (vars) => vars,
    mutation: ({ item, claim }) => setItemCompleted({ spaceId: props.spaceId, itemId: item.id, completed: true, ...claim }, t.updateFailed),
    // The shortcut moves the card away from where the user acted, often out of view, so it is confirmed with Undo.
    onSuccess: (changed, context) => {
      setOptimisticBuckets(null);
      refreshWorkspace(t.listRefreshFailed);
      if (context) confirmCompletion({ spaceId: props.spaceId, previous: context.item, changed, currentUserId: props.currentUserId }, t);
    },
    onError: (error, context) =>
      retryToast(error.message, t.retry, () => context && completeCardMutation.mutate({ ...context, item: currentCard(context.item) })),
  });

  const [claimingItemId, setClaimingItemId] = createSignal<string | null>(null);
  const claimCardMutation = mutations.create<string, SpaceItem>({
    onBefore: (item) => setClaimingItemId(item.id),
    mutation: async (item) => {
      const target = { spaceId: props.spaceId, itemId: item.id };
      if (item.claim) {
        await releaseTask(target, item.claim.id, t);
        return t.claimReleased;
      }
      await claimTask(target, t);
      return t.youAreOnIt;
    },
    onSuccess: (message) => {
      toast.success(message);
      refreshWorkspace(t.itemRefreshFailed);
    },
    onError: (error) => toast.error(error.message),
    onFinally: () => setClaimingItemId(null),
  });

  const kanbanCards = () =>
    boardScrollContainer ? Array.from(boardScrollContainer.querySelectorAll<HTMLAnchorElement>("[data-spaces-kanban-card]")) : [];

  const focusCard = (card: HTMLAnchorElement | undefined) => {
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const navigationTarget = () => {
    if (document.querySelector("dialog[open]")) return null;
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!target || !boardScrollContainer?.contains(target) || target.closest("button")) return null;
    return target;
  };

  const navigateCards = (direction: "up" | "down" | "left" | "right") => {
    const target = navigationTarget();
    if (!target) return;
    const cards = kanbanCards();
    const current = target?.closest<HTMLAnchorElement>("[data-spaces-kanban-card]") ?? null;
    if (!current) {
      focusCard(cards[0]);
      return;
    }
    const bucketKey = current.dataset.bucketKey;
    const sameBucket = cards.filter((card) => card.dataset.bucketKey === bucketKey);
    const currentIndex = sameBucket.indexOf(current);
    if (direction === "up" || direction === "down") {
      const offset = direction === "up" ? -1 : 1;
      focusCard(sameBucket[clamp(currentIndex + offset, 0, sameBucket.length - 1)]);
      return;
    }
    const bucketKeys = buckets().map((bucket) => bucket.key);
    const offset = direction === "left" ? -1 : 1;
    let bucketIndex = bucketKeys.indexOf(bucketKey ?? "") + offset;
    while (bucketIndex >= 0 && bucketIndex < bucketKeys.length) {
      const targetBucket = cards.filter((card) => card.dataset.bucketKey === bucketKeys[bucketIndex]);
      if (targetBucket.length > 0) {
        focusCard(targetBucket[clamp(currentIndex, 0, targetBucket.length - 1)]);
        return;
      }
      bucketIndex += offset;
    }
  };

  const [focusedItemId, setFocusedItemId] = createSignal<string>();
  createEffect(() => {
    if (!props.canWrite || selectedItemId()) return;
    const id = focusedItemId();
    const item = id ? findItemLocation(id)?.item : undefined;
    if (!item) return;
    const copy = spaceCommandMessages.resolve([locale()]).t;
    onCleanup(
      registerContextAwareCommand({
        scope: "selection",
        id: `spaces.${item.id}.assign`,
        title: t.assignFocusedItem,
        description: copy.assignDescription({ title: item.title }),
        icon: "ti ti-user-check",
        shortcut: "m",
        action: async () => {
          await assignCardMutation.mutate(item);
        },
      }),
    );
    if (!item.completedAt)
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `spaces.${item.id}.complete`,
          title: copy.complete({ title: item.title }),
          description: copy.completeDescription,
          icon: "ti ti-check",
          shortcut: "d",
          action: async () => {
            const claim = await resolveCompletionClaim(item.claim, props.currentUserId, true, t);
            if (claim) await completeCardMutation.mutate({ item, claim });
          },
        }),
      );
  });

  const handleBoardKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], button')) return;

    const key = event.key.toLowerCase();
    const direction = {
      arrowup: "up",
      arrowdown: "down",
      arrowleft: "left",
      arrowright: "right",
    }[key] as "up" | "down" | "left" | "right" | undefined;
    if (direction) {
      event.preventDefault();
      event.stopPropagation();
      navigateCards(direction);
    }
  };

  const bucketQuery = (bucketKey: string) => bucketQueries.find(({ initialBucket }) => initialBucket.key === bucketKey)?.pages;
  const isDropIndicatorVisible = (bucketKey: string, index: number) => {
    const intent = cardDropIntent();
    return intent?.kind === "column" && intent.bucketKey === bucketKey && intent.indicatorIndex === index;
  };
  /** Accent line in the gap where the card lands; `-my-1` cancels the extra `gap-2`, so cards never shift under the pointer. */
  const DropLine = (lineProps: { bucketKey: string; index: number }) => (
    <Show when={isDropIndicatorVisible(lineProps.bucketKey, lineProps.index)}>
      <div aria-hidden="true" data-spaces-kanban-drop-indicator class="pointer-events-none relative -my-1 h-0">
        <div class="absolute inset-x-1 top-0 h-0.5 -translate-y-1/2 rounded-full bg-[var(--ui-app-accent-border)]" />
      </div>
    </Show>
  );
  const isColumnTargetActive = (bucketKey: string) => {
    const intent = cardDropIntent();
    return intent?.kind === "column" && intent.bucketKey === bucketKey;
  };
  const isWormholeTargetActive = (wormholeId: string) => {
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "wormhole" && intent.wormholeId === wormholeId;
  };

  const columnOf = (columnId: string) => props.columns.find((column) => column.id === columnId) ?? null;
  const bucketColor = (bucket: KanbanBucketInitial) => bucket.color ?? (bucket.isDone ? "#10b981" : "#6b7280");
  const countText = (bucket: KanbanBucketInitial) =>
    bucket.unfilteredTotal === undefined ? String(bucket.total) : `${bucket.total}/${bucket.unfilteredTotal}`;
  const countLabel = (bucket: KanbanBucketInitial) =>
    bucket.unfilteredTotal === undefined
      ? t.itemCount({ count: bucket.total })
      : t.filteredColumnCount({ shown: bucket.total, total: bucket.unfilteredTotal });
  /** Folding swaps the control under focus for its counterpart, so focus follows it instead of falling to the page. */
  const toggleFolded = (bucketKey: string) => {
    props.onToggleFolded(bucketKey);
    queueMicrotask(() =>
      boardScrollContainer
        ?.querySelector<HTMLElement>(`[data-spaces-kanban-fold="${CSS.escape(bucketKey)}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  const ColumnCount = (countProps: { bucket: KanbanBucketInitial }) => (
    <span class="text-[11px] tabular-nums text-dimmed" title={countLabel(countProps.bucket)}>
      <span aria-hidden="true">{countText(countProps.bucket)}</span>
      <span class="sr-only">{countLabel(countProps.bucket)}</span>
    </span>
  );

  return (
    <div class="flex h-full min-h-0 flex-col">
      <p id={`spaces-kanban-shortcuts-${props.spaceId}`} class="sr-only">
        {props.canWrite ? t.kanbanKeyboardHelp : t.kanbanKeyboardHelpReadOnly}
      </p>
      <Show when={props.canWrite}>
        <p id={`spaces-kanban-grip-help-${props.spaceId}`} class="sr-only">
          {t.kanbanGripHelp}
        </p>
      </Show>
      <p class="sr-only" aria-live="polite" data-spaces-kanban-column-status>
        {columnAnnouncement()}
      </p>
      <div
        ref={boardScrollContainer}
        tabIndex={0}
        role="region"
        aria-label={t.kanban}
        aria-describedby={`spaces-kanban-shortcuts-${props.spaceId}`}
        onKeyDown={handleBoardKeyDown}
        onFocusIn={(event) => {
          setFocusedItemId(event.target.closest<HTMLElement>("[data-spaces-kanban-card]")?.dataset.itemId);
          if (dropFocus && !isDropFocusTarget(event.target, dropFocus)) dropFocus = null;
        }}
        onFocusOut={(event) => {
          // Focus that leaves the board for another control ends the drop's focus restore; a redrawn grip has none.
          if (event.relatedTarget instanceof Node && !boardScrollContainer?.contains(event.relatedTarget)) dropFocus = null;
          // Opening the palette transfers focus into a dialog; keep its explicit card actions.
          queueMicrotask(() => {
            if (
              !boardScrollContainer?.contains(document.activeElement) &&
              !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
            ) {
              setFocusedItemId(undefined);
            }
          });
        }}
        class="k2b-detail-trail relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded-[var(--ui-radius-surface)]"
        data-scroll-preserve={`spaces-kanban-board-${props.spaceId}`}
      >
        <div class="flex h-full min-w-max items-stretch gap-[var(--ui-space-shell)]">
          <For each={buckets()}>
            {(bucket, bucketIndex) => {
              const canDropInBucket = props.canWrite && !!resolveTargetColumnId(bucket);
              const virtual = bucket.kind === "column" ? null : bucket.kind;
              // An automatic column stays a droppable, so a card over it can say that it takes no drop.
              const cardDropDisabled = () =>
                !props.canWrite || (!canDropInBucket && !virtual) || moveMutation.loading() || transferMutation.loading();
              const refuseDrop = () => boardDnd.isDragging() && refusingBucketKey() === bucket.key;
              const registerColumn = (element: HTMLElement, draggable: boolean) => {
                columnDnd.droppable(element, () => ({
                  id: `drop:board-column:${bucket.key}`,
                  disabled: !props.canWrite,
                  meta: { bucketKey: bucket.key },
                }));
                if (!draggable) return;
                columnDnd.draggable(element, () => ({
                  id: `drag:board-column:${bucket.key}`,
                  disabled: !props.canWrite || reorderColumnsMutation.loading(),
                  focusable: false,
                  keyboard: false,
                  handleSelector: "[data-spaces-kanban-column-handle]",
                  meta: { bucketKey: bucket.key },
                }));
              };
              /** Accent line where a dragged column lands: centred in the gap beside this column, or on the outer edge of the
               * first and last column where no gap follows, since the board clips anything beyond them. Outside the flow, so
               * nothing moves. */
              const ColumnDropLine = () => (
                <>
                  <Show when={columnIndicatorIndex() === bucketIndex()}>
                    <div
                      aria-hidden="true"
                      data-spaces-kanban-column-drop-indicator
                      class={`pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-[var(--ui-app-accent-border)] ${
                        bucketIndex() === 0 ? "left-0" : "left-[calc(var(--ui-space-shell)/-2)] -translate-x-1/2"
                      }`}
                    />
                  </Show>
                  <Show when={bucketIndex() === buckets().length - 1 && columnIndicatorIndex() === buckets().length}>
                    <div
                      aria-hidden="true"
                      data-spaces-kanban-column-drop-indicator
                      class={`pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-[var(--ui-app-accent-border)] ${
                        showWormholes() ? "right-[calc(var(--ui-space-shell)/-2)] translate-x-1/2" : "right-0"
                      }`}
                    />
                  </Show>
                </>
              );
              const ColumnMark = (markProps: { class?: string }) =>
                virtual ? (
                  <i class={`ti ${virtualColumnIcon[virtual]} shrink-0 text-xs text-dimmed ${markProps.class ?? ""}`} aria-hidden="true" />
                ) : (
                  <span
                    class={`h-2 w-2 shrink-0 rounded-full ${markProps.class ?? ""}`}
                    style={`background-color:${bucketColor(bucket)}`}
                  />
                );

              return (
                <Show
                  when={!props.folded.has(bucket.key)}
                  fallback={
                    // A folded column stays a drop target: a card dropped on it lands at the top of the column.
                    <section
                      ref={(element) => registerColumn(element, false)}
                      data-spaces-kanban-column={bucket.key}
                      class="relative flex h-full w-10 shrink-0 flex-col rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1"
                    >
                      <ColumnDropLine />
                      <button
                        type="button"
                        ref={(element) => {
                          boardDnd.droppable(element, () => ({
                            id: `drop:column:${bucket.key}`,
                            disabled: cardDropDisabled(),
                            meta: { kind: "column", bucketKey: bucket.key },
                          }));
                          // The strip takes the focus of a card dropped here, unless the card still shows elsewhere.
                          restoreDropFocus(
                            element,
                            (focus) =>
                              focus.bucketKey === bucket.key &&
                              !boardScrollContainer?.querySelector(`[data-spaces-kanban-grip="${CSS.escape(focus.itemId)}"]`),
                          );
                        }}
                        data-spaces-kanban-fold={bucket.key}
                        aria-expanded="false"
                        aria-label={t.unfoldColumn({ column: bucket.label, count: countLabel(bucket) })}
                        title={t.unfoldColumn({ column: bucket.label, count: countLabel(bucket) })}
                        onClick={() => toggleFolded(bucket.key)}
                        class={`focus-ui flex min-h-0 flex-1 flex-col items-center gap-2 rounded-[var(--ui-radius-control)] px-1 py-1.5 transition-[background-color] ${
                          isColumnTargetActive(bucket.key) ? "bg-[var(--ui-selected)]" : "hover:bg-[var(--ui-hover)]"
                        } ${refuseDrop() ? "cursor-not-allowed outline-1 outline-dashed outline-[var(--ui-border-strong)]" : ""}`}
                        data-spaces-kanban-no-drop={refuseDrop() ? "" : undefined}
                      >
                        <ColumnMark class="mt-1" />
                        <span class="text-[11px] tabular-nums text-dimmed" aria-hidden="true">
                          {countText(bucket)}
                        </span>
                        <span class="min-h-0 truncate text-xs font-medium [writing-mode:vertical-rl]" aria-hidden="true">
                          {bucket.label}
                        </span>
                      </button>
                    </section>
                  }
                >
                  <section
                    ref={(element) => registerColumn(element, true)}
                    data-spaces-kanban-column={bucket.key}
                    aria-labelledby={`spaces-kanban-column-${props.spaceId}-${bucket.key}`}
                    class="relative flex h-full w-72 shrink-0 flex-col rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1"
                  >
                    <ColumnDropLine />
                    <header class="flex items-center gap-2 px-1.5 py-1">
                      {/* The title is the drag handle for people who may reorder the board; others get no affordance. A
                          touch on it still scrolls the board, so a swipe never reorders it for everyone: on touch
                          screens the ⋯ menu moves columns. */}
                      <div
                        data-spaces-kanban-column-handle={props.canWrite ? "" : undefined}
                        class={`flex min-w-0 flex-1 items-center gap-2 ${props.canWrite ? "cursor-grab select-none active:cursor-grabbing" : ""}`}
                      >
                        <Show when={virtual} fallback={<ColumnMark />}>
                          {(kind) => (
                            <Tooltip.Anchor content={kind() === "blocked" ? t.blockedColumnHelp : t.overdueColumnHelp}>
                              <span class="inline-flex">
                                <ColumnMark />
                              </span>
                            </Tooltip.Anchor>
                          )}
                        </Show>
                        <h3 id={`spaces-kanban-column-${props.spaceId}-${bucket.key}`} class="flex-1 truncate text-xs font-medium">
                          {bucket.label}
                          <Show when={virtual}>
                            {(kind) => <span class="sr-only">. {kind() === "blocked" ? t.blockedColumnHelp : t.overdueColumnHelp}</span>}
                          </Show>
                        </h3>
                      </div>
                      <ColumnCount bucket={bucket} />
                      <Show when={props.canWrite}>
                        <Dropdown.Root
                          position="bottom-left"
                          items={[
                            {
                              label: t.moveColumnLeft,
                              icon: "ti ti-arrow-left",
                              disabled: bucketIndex() === 0 || reorderColumnsMutation.loading(),
                              action: () => {
                                moveColumn(bucket.key, bucketIndex() - 1);
                                focusColumnMenu(bucket.key);
                              },
                            },
                            {
                              label: t.moveColumnRight,
                              icon: "ti ti-arrow-right",
                              disabled: bucketIndex() === buckets().length - 1 || reorderColumnsMutation.loading(),
                              action: () => {
                                moveColumn(bucket.key, bucketIndex() + 2);
                                focusColumnMenu(bucket.key);
                              },
                            },
                          ]}
                        >
                          <Dropdown.Trigger
                            iconOnly
                            size="xs"
                            variant="ghost"
                            class="h-6 w-6 text-dimmed"
                            label={t.columnActions({ column: bucket.label })}
                            data-spaces-kanban-column-menu={bucket.key}
                          >
                            <i class="ti ti-dots text-sm" aria-hidden="true" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </Show>
                      <IconButton
                        label={t.foldColumn({ column: bucket.label })}
                        size="xs"
                        class="h-6 w-6 text-dimmed"
                        data-spaces-kanban-fold={bucket.key}
                        aria-expanded="true"
                        onClick={() => toggleFolded(bucket.key)}
                      >
                        <i class="ti ti-viewport-narrow text-sm" aria-hidden="true" />
                      </IconButton>
                    </header>

                    <div class="relative flex min-h-0 flex-1 flex-col">
                      <Show when={refuseDrop()}>
                        <div
                          aria-hidden="true"
                          data-spaces-kanban-no-drop
                          class="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-[var(--ui-radius-control)] bg-[color-mix(in_srgb,var(--ui-surface-subtle)_88%,transparent)] text-xs font-medium text-dimmed outline-1 outline-dashed outline-[var(--ui-border-strong)]"
                        >
                          <i class="ti ti-ban text-base" />
                          {t.virtualColumnNoDrop}
                        </div>
                      </Show>
                      <div
                        ref={(element) => {
                          boardDnd.droppable(element, () => ({
                            id: `drop:column:${bucket.key}`,
                            disabled: cardDropDisabled(),
                            meta: { kind: "column", bucketKey: bucket.key },
                          }));
                        }}
                        class={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[var(--ui-radius-control)] p-1.5 transition-[background-color] ${
                          isColumnTargetActive(bucket.key) ? "bg-[var(--ui-selected)]" : "bg-transparent"
                        }`}
                        data-scroll-preserve={`spaces-kanban-column-${props.spaceId}-${bucket.key}`}
                      >
                        <Show
                          when={bucket.items.length > 0}
                          fallback={
                            <>
                              <DropLine bucketKey={bucket.key} index={0} />
                              <p class="px-2 py-6 text-center text-[11px] text-dimmed">
                                {bucket.unfilteredTotal
                                  ? t.noMatchingItems
                                  : virtual === "blocked"
                                    ? t.blockedColumnHelp
                                    : virtual === "overdue"
                                      ? t.overdueColumnHelp
                                      : t.noItems}
                              </p>
                            </>
                          }
                        >
                          <For each={bucket.items}>
                            {(item, itemIndex) => {
                              const priority = item.priority ? priorityMeta[item.priority] : null;
                              const isSelected = () => item.id === selectedItemId();
                              const dragId = `drag:item:${item.id}`;
                              const dropId = `drop:item:${bucket.key}:${item.id}`;
                              const isDraggingThis = () => boardDnd.activeId() === dragId;
                              // A keyboard pick-up keeps full opacity, so the focus ring on the grip stays clear.
                              const isPickedUpThis = () => keyboardMove()?.itemId === item.id;
                              const isMovingThis = () =>
                                (moveMutation.loading() || transferMutation.loading()) && movingItemId() === item.id;

                              return (
                                <>
                                  <DropLine bucketKey={bucket.key} index={itemIndex()} />
                                  <article
                                    ref={(element) => {
                                      boardDnd.droppable(element, () => ({
                                        id: dropId,
                                        disabled: cardDropDisabled(),
                                        meta: {
                                          bucketKey: bucket.key,
                                          index: itemIndex(),
                                          kind: "item",
                                        },
                                      }));
                                      boardDnd.draggable(element, () => ({
                                        id: dragId,
                                        disabled: cardDragDisabled(),
                                        focusable: false,
                                        keyboard: false,
                                        handleSelector: "[data-dnd-card-handle], [data-spaces-kanban-touch-press]",
                                        meta: { itemId: item.id },
                                      }));
                                    }}
                                    data-card-index={itemIndex()}
                                    // On touch screens the grip's 44 px area ends 39 px below the card's top and the claim button's
                                    // starts 43 px above its bottom. A card with both is 82 px tall at least, so neither takes the other's taps.
                                    class={`k2b-progressive-row relative rounded-[var(--ui-radius-control)] border p-2.5 shadow-none transition-[background-color,border-color] any-pointer-coarse:has-[[data-spaces-claim-action]]:min-h-[5.125rem] ${
                                      isPickedUpThis() || heldItemId() === item.id
                                        ? "border-[var(--ui-app-accent-border)] bg-[var(--ui-surface)]"
                                        : isSelected()
                                          ? "border-[var(--ui-border-strong)] bg-[var(--ui-selected)]"
                                          : "border-[var(--ui-border)] bg-[var(--ui-surface)] hover:bg-[var(--ui-hover)]"
                                    } ${isDraggingThis() ? "opacity-40" : ""} ${props.canWrite ? "select-none [-webkit-touch-callout:none]" : ""}`}
                                  >
                                    <Show when={props.canWrite}>
                                      <Show
                                        when={isMovingThis()}
                                        fallback={
                                          // The card link is not positioned, so the handle's touch area paints over it. A finger on the
                                          // handle must not scroll the board: the browser would cancel the drag.
                                          <div class="k2b-progressive-action absolute right-1.5 top-1.5 flex">
                                            <IconButton
                                              ref={(grip) => restoreDropFocus(grip, (focus) => focus.itemId === item.id)}
                                              data-dnd-card-handle
                                              data-spaces-kanban-grip={item.id}
                                              label={t.dragItem({ title: item.title })}
                                              tooltip={t.drag}
                                              aria-describedby={`spaces-kanban-grip-help-${props.spaceId}`}
                                              size="xs"
                                              class="!h-5 !min-h-5 !w-5 !cursor-grab touch-none !text-dimmed hover:!text-primary active:!cursor-grabbing"
                                              onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                              }}
                                              onKeyDown={(event) => handleGripKeyDown(event, item.id)}
                                              onBlur={() => {
                                                if (keyboardMove()?.itemId === item.id) cancelKeyboardMove();
                                              }}
                                            >
                                              <i class="ti ti-grip-vertical text-[13px]" aria-hidden="true" />
                                            </IconButton>
                                          </div>
                                        }
                                      >
                                        <div class="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center text-dimmed">
                                          <i class="ti ti-loader-2 animate-spin text-[11px]" />
                                        </div>
                                      </Show>
                                    </Show>
                                    <Show when={props.canWrite && !item.completedAt && !item.startsAt && !item.endsAt}>
                                      {/* The wrapper places the button: on touch screens buttons are positioned relative for their larger hit area. */}
                                      <div class={`absolute bottom-1.5 right-1.5 flex ${item.claim ? "" : "k2b-progressive-action"}`}>
                                        <ClaimButton
                                          claim={item.claim}
                                          currentUserId={props.currentUserId}
                                          canTakeOver={false}
                                          compact
                                          loading={claimingItemId() === item.id}
                                          disabled={claimCardMutation.loading() || (!item.claim && item.activeBlockerCount > 0)}
                                          class="h-6 w-6"
                                          onClaim={() => void claimCardMutation.mutate(item)}
                                          onRelease={() => void claimCardMutation.mutate(item)}
                                          onTakeOver={() => undefined}
                                        />
                                      </div>
                                    </Show>
                                    <a
                                      data-spaces-kanban-card
                                      data-bucket-key={bucket.key}
                                      data-item-id={item.id}
                                      aria-keyshortcuts={props.canWrite ? "Enter M D" : "Enter"}
                                      href={buildItemUrl(props.baseUrl, item.id)}
                                      onClick={(event) => {
                                        if (!shouldHandleDetailClick(event, event.currentTarget)) return;
                                        event.preventDefault();
                                        const href = buildItemUrl(props.baseUrl, item.id);
                                        setSelectedItemId(item.id);
                                        requestSpacesRouteNavigation(href, { scroll: "preserve" });
                                      }}
                                      // On touch screens the grip's area reaches 12 px past its box; the text ends before it, so a tap on it opens the item.
                                      class={`focus-ui block rounded-[var(--ui-radius-control)] ${props.canWrite ? "pr-5 any-pointer-coarse:pr-8" : ""}`}
                                    >
                                      <div class="flex items-start gap-2">
                                        <Show when={priority}>
                                          <i class={`ti ${priority!.icon} ${priority!.color} mt-0.5 shrink-0 text-xs`} />
                                        </Show>
                                        <p
                                          class={`break-words text-xs font-medium leading-tight ${item.completedAt ? "line-through text-dimmed" : ""}`}
                                        >
                                          {item.title}
                                        </p>
                                      </div>

                                      <Show when={descriptionPreview(item.description)}>
                                        {(preview) => <p class="mt-1.5 line-clamp-3 break-words text-[11px] text-dimmed">{preview()}</p>}
                                      </Show>

                                      <div class={`mt-2 flex flex-wrap items-center gap-1.5 ${props.canWrite ? "min-h-6 pr-6" : ""}`}>
                                        {/* In an automatic column the status is no longer the column, so the card names it. */}
                                        <Show when={virtual && columnOf(item.columnId)}>
                                          {(column) => (
                                            <span
                                              data-spaces-kanban-card-status
                                              class="inline-flex max-w-full items-center gap-1 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-1.5 text-[11px] leading-5 text-dimmed"
                                              title={t.cardStatus({ status: column().name })}
                                            >
                                              <span
                                                class="h-1.5 w-1.5 shrink-0 rounded-full"
                                                style={`background-color:${column().color ?? (column().isDone ? "#10b981" : "#6b7280")}`}
                                                aria-hidden="true"
                                              />
                                              <span class="sr-only">{t.cardStatus({ status: column().name })}</span>
                                              <span class="truncate" aria-hidden="true">
                                                {column().name}
                                              </span>
                                            </span>
                                          )}
                                        </Show>
                                        <Show when={virtual === "blocked" && isTaskOverdue(item, props.dateConfig)}>
                                          <span
                                            data-spaces-kanban-card-overdue
                                            class="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400"
                                          >
                                            <i class="ti ti-alert-triangle text-[10px]" aria-hidden="true" />
                                            {t.overdue}
                                          </span>
                                        </Show>
                                        <Show when={item.deadline}>
                                          <span class="inline-flex items-center gap-1 text-[11px] text-dimmed">
                                            <i class="ti ti-clock text-[10px]" />
                                            {dates.formatDateRelative(item.deadline!, props.dateConfig)}
                                          </span>
                                        </Show>
                                        <AssigneeAvatars
                                          assignees={item.assignees ?? []}
                                          claim={item.claim}
                                          currentUserId={props.currentUserId}
                                          max={3}
                                        />
                                        <Show when={isInactiveTask(item)}>
                                          <span
                                            class="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300"
                                            title={t.inactiveFor({ days: INACTIVE_ITEM_DAYS })}
                                          >
                                            <i class="ti ti-clock-pause text-[10px]" aria-hidden="true" />
                                            {t.inactive}
                                          </span>
                                        </Show>
                                      </div>
                                    </a>
                                  </article>
                                </>
                              );
                            }}
                          </For>
                          <DropLine bucketKey={bucket.key} index={bucket.items.length} />
                        </Show>

                        <Show when={bucketQuery(bucket.key)?.hasMore()}>
                          <IconButton
                            label={t.loadMoreIn({ group: bucket.label })}
                            size="sm"
                            onClick={() => void bucketQuery(bucket.key)?.loadMore()}
                            disabled={bucketQuery(bucket.key)?.loadingMore()}
                            class="mx-auto mt-1 h-7 w-7"
                            title={t.loadMore}
                          >
                            <i
                              class={`ti ${bucketQuery(bucket.key)?.loadingMore() ? "ti-loader-2 animate-spin" : "ti-arrow-down"} text-sm`}
                            />
                          </IconButton>
                        </Show>

                        <Show when={bucketQuery(bucket.key)?.error()}>
                          {(error) => (
                            <button
                              type="button"
                              class="focus-ui mx-1 mb-1 rounded-[var(--ui-radius-control)] px-2 py-1.5 text-left text-xs text-red-600"
                              onClick={() => void bucketQuery(bucket.key)?.refresh()}
                            >
                              {error().message} {t.retry}
                            </button>
                          )}
                        </Show>

                        <Show when={props.canWrite && bucket.columnId}>
                          <CreateItemButton
                            spaceId={props.spaceId}
                            columns={props.columns}
                            tags={props.tags}
                            templates={props.templates}
                            dateConfig={props.dateConfig}
                            variant="inline"
                            defaultType="task"
                            defaultColumnId={bucket.columnId!}
                          />
                        </Show>
                      </div>
                    </div>
                  </section>
                </Show>
              );
            }}
          </For>

          <Show when={showWormholes()}>
            <section class="flex h-full w-72 shrink-0 flex-col rounded-[var(--ui-radius-surface)] border border-[var(--ui-border-strong)] bg-[var(--ui-surface-subtle)] p-1">
              <header class="flex items-center gap-2 px-1.5 py-1.5">
                <i class="ti ti-arrow-bounce shrink-0 text-sm text-dimmed" />
                <h3 class="flex-1 truncate text-xs font-medium">{t.wormholes}</h3>
                <Tooltip.Anchor content={t.wormholesHelp}>
                  <IconButton label={t.aboutWormholes} size="xs" class="h-5 w-5">
                    <i class="ti ti-info-circle text-xs" />
                  </IconButton>
                </Tooltip.Anchor>
              </header>

              <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[var(--ui-radius-control)] p-1.5">
                <For each={props.wormholes}>
                  {(wormhole) => (
                    <Show when={wormhole.target} keyed>
                      {(target) => {
                        const active = () => isWormholeTargetActive(wormhole.id);
                        const dropLabel = t.moveItemTo({ spaceName: target.spaceName, columnName: target.columnName });

                        return (
                          <div
                            ref={(element) => {
                              boardDnd.droppable(element, () => ({
                                id: `drop:wormhole:${wormhole.id}`,
                                disabled: !props.canWrite || moveMutation.loading() || transferMutation.loading(),
                                meta: { kind: "wormhole", wormholeId: wormhole.id },
                              }));
                            }}
                            class={`flex h-36 shrink-0 flex-col items-center justify-center rounded-[var(--ui-radius-control)] border bg-[var(--ui-field)] px-5 py-4 text-center transition-[background-color,border-color,box-shadow] ${
                              active() ? "bg-[var(--ui-selected)]" : ""
                            }`}
                            style={
                              active()
                                ? `border-color:${wormhole.color};box-shadow:var(--ui-focus),inset 0 2px 5px rgb(0 0 0 / 0.08)`
                                : `border-color:color-mix(in srgb, ${wormhole.color} 30%, var(--ui-border));box-shadow:inset 0 1px 2px rgb(0 0 0 / 0.05)`
                            }
                            title={dropLabel}
                          >
                            <i class="ti ti-arrow-bounce text-2xl" style={`color:${wormhole.color}`} />
                            <p class="mt-2 max-w-full truncate text-xs font-medium text-primary">{target.spaceName}</p>
                            <p class="mt-0.5 max-w-full truncate text-[11px] text-dimmed">{target.columnName}</p>
                            <p class="mt-2 text-[11px] font-medium text-dimmed">{active() ? t.releaseToMove : t.dropItemHere}</p>
                          </div>
                        );
                      }}
                    </Show>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </div>
    </div>
  );
}
