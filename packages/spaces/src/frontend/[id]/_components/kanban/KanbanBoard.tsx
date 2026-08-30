import { type DateContext, dates } from "@k2b/stdlib";
import {
  type DndBuildIntentContext,
  type DndDraggableSnapshot,
  type DndDroppableSnapshot,
  dnd,
  mutation as mutations,
  query,
} from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import {
  INACTIVE_ITEM_DAYS,
  type ItemFilter,
  type ItemListResult,
  type SpaceColumn,
  type SpaceItem,
  type SpaceTag,
  type SpaceWormhole,
  type WormholeTransferResult,
} from "@/contracts";
import { getDetailItemFromUrl, shouldHandleDetailClick, subscribeToDetailSelection } from "../../../lib/detail";
import { isTypingTarget } from "../../../lib/keyboard";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import { isInactiveTask } from "../shared/item-activity";
import CreateItemButton from "../sidebar/CreateItemButton";
import { invalidateSpacesData, requestSpacesRouteNavigation, subscribeToSpacesDataInvalidation } from "../workspace/workspace-events";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import type { KanbanBucketInitial } from "./types";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  selectedItemId?: string;
  initialBuckets: KanbanBucketInitial[];
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
      previewIndex: number;
    }
  | { kind: "wormhole"; wormholeId: string };

type MoveContext = {
  previousBuckets: KanbanBucketInitial[];
  sourceBucketKey: string;
  targetBucketKey: string;
  targetColumnId: string;
  targetRank: string;
  targetIndex: number;
  targetCompleted: boolean;
};

type TransferContext = {
  previousBuckets: KanbanBucketInitial[];
};

const RANK_STEP = 1024n;
const boardScrollMemory = new Map<string, { left: number; top: number }>();

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

const toRank = (value: string) => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const betweenRanks = (before: bigint | null, after: bigint | null): bigint | null => {
  if (before === null && after === null) return RANK_STEP;
  if (before === null) {
    if (after! > RANK_STEP) return after! - RANK_STEP;
    return after! - 1n;
  }
  if (after === null) return before + RANK_STEP;
  if (after <= before) return null;
  const gap = after - before;
  if (gap <= 1n) return null;
  return before + gap / 2n;
};

const computeInsertRank = (items: SpaceItem[], insertIndex: number): bigint => {
  const before = insertIndex > 0 ? items[insertIndex - 1] : null;
  const after = insertIndex < items.length ? items[insertIndex] : null;
  const midpoint = betweenRanks(before ? toRank(before.rank) : null, after ? toRank(after.rank) : null);
  if (midpoint !== null) return midpoint;
  if (before) return toRank(before.rank) + 1n;
  if (after) return toRank(after.rank) - 1n;
  return RANK_STEP;
};

const buildRequest = (params: { bucket: KanbanBucketInitial; page: number; pageSize: number }): ItemFilter => {
  const { bucket, page, pageSize } = params;
  return {
    type: "all",
    status: bucket.isDone ? "completed" : "active",
    activity: "all",
    priority: undefined,
    tagIds: undefined,
    columnIds: bucket.columnId ? [bucket.columnId] : undefined,
    assignedTo: "all",
    deadlineFilter: "all",
    search: undefined,
    sort: "column",
    sortDesc: false,
    groupBy: "column",
    page,
    pageSize,
  };
};

/**
 * Kanban board with SSR-initialized buckets, drag/drop reordering and explicit per-column "load more".
 */
export default function KanbanBoard(props: Props) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const bucketQueries = props.initialBuckets.map((initialBucket) => {
    const source = `${props.spaceId}:${initialBucket.key}`;
    const initialPage: ItemListResult = {
      items: initialBucket.items,
      page: initialBucket.page,
      pageSize: props.pageSize,
      totalPages: initialBucket.totalPages,
      total: initialBucket.total,
    };
    const pages = query.createInfinite<string, ItemListResult, number, { cursor: string | null }>({
      source: () => source,
      initial: { source, pages: [initialPage] },
      loadPage: async (_source, { cursor, abortSignal }) => {
        const res = await apiClient[":id"].items.filter.$post(
          {
            param: { id: props.spaceId },
            json: buildRequest({ bucket: initialBucket, page: cursor ?? 1, pageSize: props.pageSize }),
          },
          { init: { signal: abortSignal } },
        );
        if (!res.ok) throw new Error(await readResponseError(res, t.loadItemsFailed));
        const result = await res.json();
        if (result.page !== (cursor ?? 1)) throw new Error(t.invalidKanbanPage);
        return result;
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
      return {
        ...initialBucket,
        items,
        page: lastPage?.page ?? initialBucket.page,
        totalPages: lastPage?.totalPages ?? initialBucket.totalPages,
        total: lastPage?.total ?? initialBucket.total,
      };
    });
  const [optimisticBuckets, setOptimisticBuckets] = createSignal<KanbanBucketInitial[] | null>(null);
  const buckets = () => optimisticBuckets() ?? canonicalBuckets();
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

    const previewIndex = normalizeTargetIndex({
      sourceBucketKey: resolved.source.bucket.key,
      sourceIndex: resolved.source.index,
      targetBucketKey: resolved.targetBucket.key,
      targetBucketLength: resolved.targetBucket.items.length,
      rawIndex,
    });

    return {
      kind: "column" as const,
      bucketKey: resolved.targetBucket.key,
      rawInsertIndex: rawIndex,
      previewIndex,
    };
  };

  const describeDroppable = (over: DndDroppableSnapshot<DropMeta> | null) => {
    if (!over) return t.noTarget;
    if (over.meta.kind === "wormhole") {
      const target = getWormholeById(over.meta.wormholeId)?.target;
      return target ? t.wormholeTarget({ space: target.spaceName, column: target.columnName }) : t.unavailableWormhole;
    }
    const bucket = getBucketByKey(over.meta.bucketKey);
    return bucket ? t.columnTarget({ column: bucket.label }) : t.unknownTarget;
  };

  const describeActiveItem = (active: DndDraggableSnapshot<DragMeta>) => {
    const location = findItemLocation(active.meta.itemId);
    return location?.item.title ?? t.genericItem;
  };

  const boardDnd = dnd.create<DragMeta, DropMeta, DropIntent>({
    buildIntent: buildDropIntent,
    announcements: {
      dragStart: (active) => t.dragPickedUp({ item: describeActiveItem(active) }),
      dragOver: (_active, over) => describeDroppable(over),
      drop: (active, over) => t.dragDropped({ item: describeActiveItem(active), target: describeDroppable(over) }),
      cancel: (active) => t.dragCancelled({ item: describeActiveItem(active) }),
    },
    onDrop: ({ active, intent }) => {
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
      const targetRank = computeInsertRank(targetItemsWithoutSource, targetIndexClamped);
      const optimisticUpdated: SpaceItem = {
        ...resolved.source.item,
        columnId: targetColumnId,
        rank: targetRank.toString(),
        completedAt: resolved.targetBucket.isDone ? new Date().toISOString() : null,
      };

      withBoardScrollPreserved(() => {
        withViewTransition(() => {
          setBuckets((current) =>
            current.map((bucket) => {
              const hadItem = bucket.items.some((item) => item.id === itemId);
              const nextItems = bucket.items.filter((item) => item.id !== itemId);
              let total = bucket.total - (hadItem ? 1 : 0);

              if (bucket.key === resolved.targetBucket.key) {
                nextItems.splice(targetIndexClamped, 0, optimisticUpdated);
                total += 1;
              }

              return {
                ...bucket,
                items: nextItems,
                total: Math.max(total, 0),
              };
            }),
          );
        });
      });

      setMovingItemId(itemId);
      return {
        previousBuckets,
        sourceBucketKey: resolved.source.bucket.key,
        targetBucketKey: resolved.targetBucket.key,
        targetColumnId,
        targetRank: targetRank.toString(),
        targetIndex: targetIndexClamped,
        targetCompleted: resolved.targetBucket.isDone,
      };
    },
    mutation: async (vars, ctx) => {
      const moveRes = await apiClient[":id"].items[":itemId"].move.$post({
        param: { id: props.spaceId, itemId: vars.itemId },
        json: {
          columnId: ctx.targetColumnId,
          rank: ctx.targetRank,
          completed: ctx.targetCompleted,
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
              let total = bucket.total - (hadItem ? 1 : 0);

              if (bucket.key === ctx?.targetBucketKey) {
                const insertIndex = clamp(ctx.targetIndex, 0, nextItems.length);
                nextItems.splice(insertIndex, 0, updated);
                total += 1;
              }

              return {
                ...bucket,
                items: nextItems,
                total: Math.max(total, 0),
              };
            }),
          );
        });
      });
      void invalidateSpacesData(["view"]).catch(() => prompts.error(t.moveRefreshFailed));
    },
    onError: (error, ctx) => {
      if (ctx?.previousBuckets) {
        withBoardScrollPreserved(() => {
          withViewTransition(() => {
            setBuckets(ctx.previousBuckets);
          });
        });
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
              return hadItem
                ? { ...bucket, items: bucket.items.filter((item) => item.id !== itemId), total: Math.max(0, bucket.total - 1) }
                : bucket;
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

  const assignShortcutMutation = mutations.create<SpaceItem, SpaceItem>({
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

  const completeShortcutMutation = mutations.create<SpaceItem, SpaceItem>({
    mutation: async (item) => {
      const response = await apiClient[":id"].items[":itemId"].completed.$post({
        param: { id: props.spaceId, itemId: item.id },
        json: { completed: true },
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

  const kanbanCards = () =>
    boardScrollContainer ? Array.from(boardScrollContainer.querySelectorAll<HTMLAnchorElement>("[data-spaces-kanban-card]")) : [];

  const focusCard = (card: HTMLAnchorElement | undefined) => {
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const handleBoardKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("button")) return;
    const cards = kanbanCards();
    const current = target?.closest<HTMLAnchorElement>("[data-spaces-kanban-card]") ?? null;

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      if (!current) {
        focusCard(cards[0]);
        return;
      }
      const bucketKey = current.dataset.bucketKey;
      const sameBucket = cards.filter((card) => card.dataset.bucketKey === bucketKey);
      const currentIndex = sameBucket.indexOf(current);
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const offset = event.key === "ArrowUp" ? -1 : 1;
        focusCard(sameBucket[clamp(currentIndex + offset, 0, sameBucket.length - 1)]);
        return;
      }
      const bucketKeys = buckets().map((bucket) => bucket.key);
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      let bucketIndex = bucketKeys.indexOf(bucketKey ?? "") + offset;
      while (bucketIndex >= 0 && bucketIndex < bucketKeys.length) {
        const targetBucket = cards.filter((card) => card.dataset.bucketKey === bucketKeys[bucketIndex]);
        if (targetBucket.length > 0) {
          focusCard(targetBucket[clamp(currentIndex, 0, targetBucket.length - 1)]);
          return;
        }
        bucketIndex += offset;
      }
      return;
    }

    if (!current || !props.canWrite || event.repeat) return;
    const location = findItemLocation(current.dataset.itemId ?? "");
    if (!location) return;
    if (event.key.toLowerCase() === "m") {
      event.preventDefault();
      if (!assignShortcutMutation.loading()) assignShortcutMutation.mutate(location.item);
    } else if (event.key.toLowerCase() === "d" && !location.item.completedAt) {
      event.preventDefault();
      if (!completeShortcutMutation.loading()) completeShortcutMutation.mutate(location.item);
    }
  };

  const bucketQuery = (bucketKey: string) => bucketQueries.find(({ initialBucket }) => initialBucket.key === bucketKey)?.pages;
  const isDropIndicatorVisible = (bucketKey: string, index: number) => {
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "column" && intent.bucketKey === bucketKey && intent.previewIndex === index;
  };
  const isColumnTargetActive = (bucketKey: string) => {
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "column" && intent.bucketKey === bucketKey;
  };
  const isWormholeTargetActive = (wormholeId: string) => {
    const intent = boardDnd.intent();
    return boardDnd.isDragging() && intent?.kind === "wormhole" && intent.wormholeId === wormholeId;
  };

  return (
    <div class="flex h-full min-h-0 flex-col gap-2">
      <p id={`spaces-kanban-shortcuts-${props.spaceId}`} class="px-1 text-[11px] text-dimmed">
        {t.kanbanKeyboardHelp}
      </p>
      <div
        ref={boardScrollContainer}
        tabIndex={0}
        role="region"
        aria-label={t.kanban}
        aria-describedby={`spaces-kanban-shortcuts-${props.spaceId}`}
        onKeyDown={handleBoardKeyDown}
        class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
        data-scroll-preserve={`spaces-kanban-board-${props.spaceId}`}
      >
        <div class="flex h-full min-w-max items-stretch gap-[var(--ui-space-shell)]">
          <For each={buckets()}>
            {(bucket) => {
              const canDropInBucket = props.canWrite && !!resolveTargetColumnId(bucket);

              return (
                <section class="flex h-full w-72 shrink-0 flex-col rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1">
                  <header class="flex items-center gap-2 px-1.5 py-1.5">
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      style={`background-color:${bucket.color ?? (bucket.isDone ? "#10b981" : "#6b7280")}`}
                    />
                    <h3 class="flex-1 truncate text-xs font-medium">{bucket.label}</h3>
                    <span class="text-[11px] tabular-nums text-dimmed">{bucket.total}</span>
                  </header>

                  <div
                    ref={(element) => {
                      boardDnd.droppable(element, () => ({
                        id: `drop:column:${bucket.key}`,
                        disabled: !canDropInBucket || moveMutation.loading() || transferMutation.loading(),
                        meta: { kind: "column", bucketKey: bucket.key },
                      }));
                    }}
                    class={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-[var(--ui-radius-control)] p-1.5 transition-[background-color,box-shadow] ${
                      isColumnTargetActive(bucket.key)
                        ? "bg-[var(--ui-selected)] [box-shadow:inset_0_0_0_1px_var(--ui-focus)]"
                        : "bg-transparent"
                    }`}
                    data-scroll-preserve={`spaces-kanban-column-${props.spaceId}-${bucket.key}`}
                  >
                    <Show
                      when={bucket.items.length > 0}
                      fallback={<p class="px-2 py-6 text-center text-[11px] text-dimmed">{t.noItems}</p>}
                    >
                      <For each={bucket.items}>
                        {(item, itemIndex) => {
                          const priority = item.priority ? priorityMeta[item.priority] : null;
                          const isSelected = () => item.id === selectedItemId();
                          const dragId = `drag:item:${item.id}`;
                          const dropId = `drop:item:${bucket.key}:${item.id}`;
                          const isDraggingThis = () => boardDnd.activeId() === dragId;
                          const isMovingThis = () => (moveMutation.loading() || transferMutation.loading()) && movingItemId() === item.id;

                          return (
                            <>
                              <Show when={isDropIndicatorVisible(bucket.key, itemIndex())}>
                                <div class="relative z-10 h-4">
                                  <div class="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-[var(--ui-focus)]" />
                                </div>
                              </Show>
                              <article
                                ref={(element) => {
                                  boardDnd.droppable(element, () => ({
                                    id: dropId,
                                    disabled: !canDropInBucket || moveMutation.loading() || transferMutation.loading(),
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

                                  <div class="mt-2 flex flex-wrap items-center gap-1.5">
                                    <Show when={item.deadline}>
                                      <span class="inline-flex items-center gap-1 text-[11px] text-dimmed">
                                        <i class="ti ti-clock text-[10px]" />
                                        {dates.formatDateRelative(item.deadline!, props.dateConfig)}
                                      </span>
                                    </Show>
                                    <Show when={item.assignees && item.assignees.length > 0}>
                                      <AssigneeAvatars assignees={item.assignees!} max={3} />
                                    </Show>
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
                    </Show>

                    <Show when={isDropIndicatorVisible(bucket.key, bucket.items.length)}>
                      <div class="relative z-10 h-4">
                        <div class="absolute inset-x-1 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-[var(--ui-focus)]" />
                      </div>
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
                        <i class={`ti ${bucketQuery(bucket.key)?.loadingMore() ? "ti-loader-2 animate-spin" : "ti-arrow-down"} text-sm`} />
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
                </section>
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
                                ? `border-color:${wormhole.color};box-shadow:inset 0 0 0 1px var(--ui-focus),inset 0 2px 5px rgb(0 0 0 / 0.08)`
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
