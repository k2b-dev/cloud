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
import { Dropdown, IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import {
  INACTIVE_ITEM_DAYS,
  type ItemListResult,
  type SpaceColumn,
  type SpaceItem,
  type SpaceTag,
  type SpaceWormhole,
  type WormholeTransferResult,
} from "@/contracts";
import { spaceCommandMessages } from "../../../../commands";
import { getDetailItemFromUrl, shouldHandleDetailClick, subscribeToDetailSelection } from "../../../lib/detail";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import { defaultFilter, type FilterState, hasActiveFilters } from "../filter/types";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import ClaimButton from "../shared/claim/ClaimButton";
import { claimTask, ownClaimId, releaseTask } from "../shared/claim/claim";
import { isInactiveTask } from "../shared/item-activity";
import CreateItemButton from "../sidebar/CreateItemButton";
import { invalidateSpacesData, requestSpacesRouteNavigation, subscribeToSpacesDataInvalidation } from "../workspace/workspace-events";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import { boardVirtualKinds, kanbanBucketFilter } from "./bucket-filter";
import type { KanbanBucketInitial } from "./types";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
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
  /** Set when the card leaves an automatic column for a status it still matches there: it stays, with the new status. */
  staysIn: "blocked" | "overdue" | null;
  targetLabel: string;
  sourceBucketKey: string;
  targetBucketKey: string;
  targetColumnId: string;
  position: MovePosition;
  targetIndex: number;
  targetCompleted: boolean;
  claimId: string | undefined;
};

/** Where a dragged column header lands: before the board column at this index, or at the end. */
type ColumnIntent = { index: number };

type TransferContext = {
  previousBuckets: KanbanBucketInitial[];
};

/** A column page; the first page of a filtered column also carries the column's unfiltered size. */
type KanbanPage = ItemListResult & { unfilteredTotal?: number };

const boardScrollMemory = new Map<string, { left: number; top: number }>();

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
  // The route mounts a new board for every snapshot, so one board keeps one filter for its lifetime.
  const filter = props.filter;
  const filtered = hasActiveFilters(filter);
  const virtualKinds = boardVirtualKinds(props.initialBuckets);
  const bucketQueries = props.initialBuckets.map((initialBucket) => {
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
      subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["view"], invalidate),
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
    // A card that stays in its automatic column and keeps its status would change nothing visible.
    if (
      resolved.source.bucket.kind !== "column" &&
      !resolved.targetBucket.isDone &&
      resolved.source.item.columnId === resolved.targetBucket.columnId
    ) {
      return true;
    }
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

    const resolved = resolveMoveTargets({
      itemId: ctx.active.meta.itemId,
      bucketKey: ctx.over.meta.bucketKey,
    });
    if (!resolved) return null;

    if (!resolveTargetColumnId(resolved.targetBucket)) {
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

  // The column under a dragged card, also when it takes no drop, so an automatic column can say so.
  const [cardOverBucketKey, setCardOverBucketKey] = createSignal<string | null>(null);
  const boardDnd = dnd.create<DragMeta, DropMeta, DropIntent>({
    buildIntent: buildDropIntent,
    onDragOver: ({ over }) => setCardOverBucketKey(over && over.meta.kind !== "wormhole" ? over.meta.bucketKey : null),
    onCancel: () => setCardOverBucketKey(null),
    announcements: {
      dragStart: (active) => t.dragPickedUp({ item: describeActiveItem(active) }),
      dragOver: (_active, over) => describeDroppable(over),
      drop: (active, over) => t.dragDropped({ item: describeActiveItem(active), target: describeDroppable(over) }),
      cancel: (active) => t.dragCancelled({ item: describeActiveItem(active) }),
    },
    onDrop: ({ active, intent }) => {
      setCardOverBucketKey(null);
      if (!intent || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
      if (intent.kind === "wormhole") {
        transferMutation.mutate({ itemId: active.meta.itemId, wormholeId: intent.wormholeId });
        return;
      }
      if (isNoOpMove(active.meta.itemId, intent)) return;
      moveMutation.mutate({
        itemId: active.meta.itemId,
        intent,
      });
    },
  });

  onMount(() => {
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
      prompts.error(error.message);
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
  const columnDnd = dnd.create<{ bucketKey: string }, { bucketKey: string }, ColumnIntent>({
    isSameIntent: (a, b) => a?.index === b?.index,
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
      drop: (active): string => (columnDnd.intent() ? "" : t.columnMoveCancelled({ column: bucketLabel(active.meta.bucketKey) })),
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

  const moveMutation = mutations.create<SpaceItem, { itemId: string; intent: DropIntent }, MoveContext>({
    onBefore: ({ itemId, intent }) => {
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
      const optimisticUpdated: SpaceItem = {
        ...resolved.source.item,
        columnId: targetColumnId,
        completedAt: resolved.targetBucket.isDone ? new Date().toISOString() : null,
      };
      // Only completion ends blocked or overdue, so a card from an automatic column that lands in an open
      // status changes its status but stays where it is.
      const sourceBucket = resolved.source.bucket;
      const staysIn = sourceBucket.kind !== "column" && !resolved.targetBucket.isDone ? sourceBucket.kind : null;

      withBoardScrollPreserved(() => {
        withViewTransition(() => {
          setBuckets((current) =>
            current.map((bucket) => {
              if (staysIn) {
                return bucket.key === sourceBucket.key
                  ? { ...bucket, items: bucket.items.map((item) => (item.id === itemId ? optimisticUpdated : item)) }
                  : bucket;
              }
              const hadItem = bucket.items.some((item) => item.id === itemId);
              const nextItems = bucket.items.filter((item) => item.id !== itemId);
              let delta = hadItem ? -1 : 0;

              if (bucket.key === resolved.targetBucket.key) {
                nextItems.splice(targetIndexClamped, 0, optimisticUpdated);
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
        staysIn,
        targetLabel: resolved.targetBucket.label,
        sourceBucketKey: sourceBucket.key,
        targetBucketKey: staysIn ? sourceBucket.key : resolved.targetBucket.key,
        targetColumnId,
        // A folded column shows no cards to land next to; without a position the server puts the card at
        // the top of the whole column, above cards an active filter hides.
        position: props.folded.has(resolved.targetBucket.key) ? {} : movePosition(targetItemsWithoutSource, targetIndexClamped),
        targetIndex: staysIn ? resolved.source.index : targetIndexClamped,
        targetCompleted: resolved.targetBucket.isDone,
        claimId: resolved.targetBucket.isDone ? ownClaimId(resolved.source.item.claim, props.currentUserId) : undefined,
      };
    },
    mutation: async (vars, ctx) => {
      const moveRes = await apiClient[":id"].items[":itemId"].move.$post({
        param: { id: props.spaceId, itemId: vars.itemId },
        json: {
          columnId: ctx.targetColumnId,
          ...ctx.position,
          completed: ctx.targetCompleted,
          claimId: ctx.claimId,
        },
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
      if (ctx?.staysIn) {
        toast(
          ctx.staysIn === "blocked" ? t.movedStaysBlocked({ status: ctx.targetLabel }) : t.movedStaysOverdue({ status: ctx.targetLabel }),
        );
      }
      void invalidateSpacesData(["view"]).catch(() => prompts.error(t.moveRefreshFailed));
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
      prompts.error(error.message);
    },
    onAbort: (ctx) => {
      if (ctx?.previousBuckets) setBuckets(ctx.previousBuckets);
    },
    onFinally: () => setMovingItemId(null),
  });

  const transferMutation = mutations.create<WormholeTransferResult, { itemId: string; wormholeId: string }, TransferContext>({
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
        signal: context.abortSignal,
        locale: locale(),
      }),
    onSuccess: (result) => {
      showWormholeTransferToast(result, locale());
      void invalidateSpacesData(["view"]).catch(() => prompts.error(t.transferRefreshFailed));
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
      if (error.name !== "AbortError") prompts.error(error.message);
    },
    onAbort: (context) => {
      if (context?.previousBuckets) setBuckets(context.previousBuckets);
    },
    onFinally: () => setMovingItemId(null),
  });

  const assignCardMutation = mutations.create<SpaceItem, SpaceItem>({
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
      toast.success(alreadyAssigned ? t.alreadyAssignedToYou : t.assignedToYou);
      if (!alreadyAssigned) {
        void invalidateSpacesData()
          .then(refocus)
          .catch(() => prompts.error(t.itemRefreshFailed));
      }
    },
    onError: (error) => prompts.error(error.message),
  });

  const completeCardMutation = mutations.create<SpaceItem, SpaceItem>({
    mutation: async (item) => {
      const response = await apiClient[":id"].items[":itemId"].completed.$post({
        param: { id: props.spaceId, itemId: item.id },
        json: { completed: true, claimId: ownClaimId(item.claim, props.currentUserId) },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.updateFailed));
      return response.json();
    },
    onSuccess: () => {
      setOptimisticBuckets(null);
      toast.success(t.itemCompleted);
      void invalidateSpacesData().catch(() => prompts.error(t.listRefreshFailed));
    },
    onError: (error) => prompts.error(error.message),
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
      void invalidateSpacesData().catch(() => prompts.error(t.itemRefreshFailed));
    },
    onError: (error) => prompts.error(error.message),
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
            await completeCardMutation.mutate(item);
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
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "column" && intent.bucketKey === bucketKey && intent.indicatorIndex === index;
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
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "column" && intent.bucketKey === bucketKey;
  };
  const isWormholeTargetActive = (wormholeId: string) => {
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "wormhole" && intent.wormholeId === wormholeId;
  };

  const columnOf = (columnId: string) => props.columns.find((column) => column.id === columnId) ?? null;
  /** Overdue as the board counts it: an open task whose deadline lies before today. */
  const isOverdue = (item: SpaceItem) =>
    !item.completedAt && item.deadline !== null && new Date(item.deadline) < dates.today(props.dateConfig);
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
        onFocusIn={(event) => setFocusedItemId(event.target.closest<HTMLElement>("[data-spaces-kanban-card]")?.dataset.itemId)}
        onFocusOut={() => {
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
        class="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
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
              const refuseDrop = () => virtual !== null && boardDnd.isDragging() && cardOverBucketKey() === bucket.key;
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
              /** Accent line on the edge where a dragged column lands; outside the flow, so nothing moves, and never clipped by the board. */
              const ColumnDropLine = () => (
                <>
                  <Show when={columnIndicatorIndex() === bucketIndex()}>
                    <div
                      aria-hidden="true"
                      data-spaces-kanban-column-drop-indicator
                      class="pointer-events-none absolute inset-y-1 left-0 z-20 w-0.5 rounded-full bg-[var(--ui-app-accent-border)]"
                    />
                  </Show>
                  <Show when={bucketIndex() === buckets().length - 1 && columnIndicatorIndex() === buckets().length}>
                    <div
                      aria-hidden="true"
                      data-spaces-kanban-column-drop-indicator
                      class="pointer-events-none absolute inset-y-1 right-0 z-20 w-0.5 rounded-full bg-[var(--ui-app-accent-border)]"
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
                      {/* The title is the drag handle for people who may reorder the board; others get no affordance. */}
                      <div
                        data-spaces-kanban-column-handle={props.canWrite ? "" : undefined}
                        class={`flex min-w-0 flex-1 items-center gap-2 ${props.canWrite ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""}`}
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
                                        disabled: !props.canWrite || moveMutation.loading() || transferMutation.loading(),
                                        focusable: false,
                                        keyboard: false,
                                        handleSelector: "[data-dnd-card-handle]",
                                        meta: { itemId: item.id },
                                      }));
                                    }}
                                    data-card-index={itemIndex()}
                                    class={`group/card relative rounded-[var(--ui-radius-control)] border p-2.5 shadow-none transition-[background-color,border-color] ${
                                      isSelected()
                                        ? "border-[var(--ui-border-strong)] bg-[var(--ui-selected)]"
                                        : "border-[var(--ui-border)] bg-[var(--ui-surface)] hover:bg-[var(--ui-hover)]"
                                    } ${isDraggingThis() ? "opacity-40" : ""}`}
                                  >
                                    <Show when={props.canWrite}>
                                      <Show
                                        when={isMovingThis()}
                                        fallback={
                                          <button
                                            type="button"
                                            data-dnd-card-handle
                                            aria-label={t.dragItem({ title: item.title })}
                                            title={t.drag}
                                            class="focus-ui absolute right-1.5 top-1.5 inline-flex h-5 w-5 cursor-grab items-center justify-center rounded-[var(--ui-radius-control)] text-dimmed opacity-0 transition-[color,background-color,opacity] hover:bg-[var(--ui-hover)] hover:text-primary group-hover/card:opacity-100 group-focus-within/card:opacity-100 active:cursor-grabbing"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                            }}
                                          >
                                            <i class="ti ti-grip-vertical text-[13px]" />
                                          </button>
                                        }
                                      >
                                        <div class="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center text-dimmed">
                                          <i class="ti ti-loader-2 animate-spin text-[11px]" />
                                        </div>
                                      </Show>
                                    </Show>
                                    <Show when={props.canWrite && !item.completedAt && !item.startsAt && !item.endsAt}>
                                      {/* The wrapper places the button: on touch screens buttons are positioned relative for their larger hit area. */}
                                      <div class="absolute bottom-1.5 right-1.5 flex">
                                        <ClaimButton
                                          claim={item.claim}
                                          currentUserId={props.currentUserId}
                                          isAdmin={false}
                                          compact
                                          loading={claimingItemId() === item.id}
                                          disabled={claimCardMutation.loading() || (!item.claim && item.activeBlockerCount > 0)}
                                          class={`h-6 w-6 ${
                                            item.claim ? "" : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
                                          }`}
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
                                      class={`focus-ui block rounded-[var(--ui-radius-control)] ${props.canWrite ? "pr-5" : ""}`}
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

                                      <Show when={item.description}>
                                        <p class="mt-1.5 line-clamp-3 break-words text-[11px] text-dimmed">{item.description}</p>
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
                                        <Show when={virtual === "blocked" && isOverdue(item)}>
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
                              {error().message} Retry
                            </button>
                          )}
                        </Show>

                        <Show when={props.canWrite && bucket.columnId}>
                          <CreateItemButton
                            spaceId={props.spaceId}
                            columns={props.columns}
                            tags={props.tags}
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

          <Show when={props.canWrite && props.wormholes.length > 0}>
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
                        const dropLabel = `Move item to ${target.spaceName}, ${target.columnName}`;

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
