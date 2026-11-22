import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  activeDrag,
  announce,
  Dropdown,
  type DropdownSection,
  DropTarget,
  dragStatus,
  IconButton,
  SortableList,
  type SortableMove,
  StatusBadge,
  Tag,
  type ToastHandle,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { apiClient } from "@/api/client";
import {
  INACTIVE_ITEM_DAYS,
  type ItemListResult,
  type SpaceColumn,
  type SpaceItem,
  type SpaceItemReaction,
  type SpaceItemTemplate,
  type SpaceTag,
  type SpaceVirtualColumnKind,
  type SpaceWormhole,
  type WormholeTransferResult,
} from "@/contracts";
import { formatDeadline } from "@/presentation/deadline";
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
import ItemReactions, { createReactionPicker } from "../shared/reactions/ItemReactions";
import { onReactionAnswer } from "../shared/reactions/reaction-queue";
import CreateItemButton from "../sidebar/CreateItemButton";
import {
  invalidateSpacesData,
  requestSpacesRouteNavigation,
  subscribeToSpacesDataInvalidation,
  subscribeToSpacesDetailStep,
} from "../workspace/workspace-events";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import { type BoardSummary, boardSummary } from "./board-summary";
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
  /** Tells the route what its status row shows: the board's size and key figures, from the columns it holds. */
  onSummary?: (summary: BoardSummary) => void;
};

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
  /** Where the card came from, for the toast's "Undo"; absent for an undo itself. */
  undo: UndoMove | null;
};

/** The place a moved card came from: its column on the board, its index there, and its status. */
type UndoMove = { title: string; bucketKey: string; index: number; columnId: string; completedAt: string | null };

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
  const retryToast = createRetryToasts();
  const reactionPicker = createReactionPicker();
  const cardMetaId = (itemId: string) => `spaces-kanban-card-meta-${props.spaceId}-${itemId}`;
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
  const bucketKeys = createMemo(() => buckets().map((bucket) => bucket.key));
  /**
   * Reactions as the columns last read them. A card can show a board copy a write made, whose write response carries no
   * reactions and which a later reload does not update, so its chips come from the reads instead.
   */
  const readReactions = createMemo(
    () => new Map(canonicalBuckets().flatMap((bucket) => bucket.items.map((item) => [item.id, item.reactions] as const))),
  );
  /**
   * The newest reactions the board has seen per card, from a column read or a saved reaction's answer, in the order they
   * arrived. A card that no loaded page holds any more, but that the board copy still shows (#1388), gets no reload,
   * so it shows these. A read that holds the card always wins, so a late answer never hides a fresher live reload.
   */
  const [seenReactions, setSeenReactions] = createSignal<ReadonlyMap<string, SpaceItemReaction[] | undefined>>(new Map());
  const seeReactions = (seen: Iterable<readonly [string, SpaceItemReaction[] | undefined]>) =>
    setSeenReactions((current) => new Map([...current, ...seen]));
  createEffect(() => {
    const read = readReactions();
    untrack(() => seeReactions(read));
  });
  onMount(() =>
    onCleanup(
      onReactionAnswer((target, reactions) => {
        if (target.spaceId === props.spaceId) seeReactions([[target.itemId, reactions]]);
      }),
    ),
  );
  const cardReactions = (item: SpaceItem) => readReactions().get(item.id) ?? seenReactions().get(item.id) ?? item.reactions;
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

  // ---- Moving cards: every column is a SortableList of one group (K7), so the pointer, the keyboard lift, and touch all
  // run through the shared engine. The board only turns the engine's index into the column gap its rules use.
  const group = `spaces-board:${props.spaceId}`;
  const dragType = `k2b-sortable:${group}`;
  /** The grip that has keyboard focus; a keyboard lift moves its card. */
  const [focusedGrip, setFocusedGrip] = createSignal<string | null>(null);
  /** The card on its way now, by pointer or by keyboard, if it is one of this board's. */
  const draggedItemId = () => {
    const drag = activeDrag();
    if (drag) return drag.type === dragType ? drag.value : null;
    return dragStatus() ? focusedGrip() : null;
  };
  /**
   * The engine reports a move into `bucketKey` at `index`, the card's place once it has moved. The column rules work on
   * the gap in the rendered column, which still shows the card in its old place.
   */
  const moveFromEngine = (bucketKey: string, itemId: string, index: number, move: SortableMove) => {
    const bucket = getBucketByKey(bucketKey);
    const source = findItemLocation(itemId);
    if (!bucket || !source) return;
    if (bucket.kind !== "column") {
      // An automatic column orders its cards itself and takes none from elsewhere.
      if (move.from !== bucketKey) announce(t.dragRefused({ item: source.item.title, column: bucket.label }));
      return;
    }
    // The card's place now, not at the lift: a live refresh may have moved it meanwhile.
    const rawIndex = props.folded.has(bucketKey) ? 0 : source.bucket.key === bucketKey && index > source.index ? index + 1 : index;
    moveCard(itemId, bucketKey, rawIndex);
  };
  /** Moves a card into the gap `rawIndex` of a status column, with an "Undo" afterwards. */
  const moveCard = (itemId: string, bucketKey: string, rawIndex: number) => {
    const source = findItemLocation(itemId);
    const intent = columnDropIntent(itemId, bucketKey, rawIndex);
    if (!source || !intent || isNoOpMove(itemId, intent)) {
      if (source) announce(t.dragNotMoved({ item: source.item.title }));
      return;
    }
    // One write at a time: a move during another one's save would be lost, so it says so instead.
    if (movingItemId() || moveMutation.loading() || transferMutation.loading()) {
      toast(t.moveWaits, { title: t.moveWaitsTitle });
      return;
    }
    const undo: UndoMove = {
      title: source.item.title,
      bucketKey: source.bucket.key,
      index: source.index,
      columnId: source.item.columnId,
      completedAt: source.item.completedAt,
    };
    // A keyboard lift keeps the focus on the card's grip; it follows the card once the board shows it in its place.
    const keepFocus = focusedGrip() === itemId;
    void dropCard(itemId, intent, undo, keepFocus ? bucketKey : null);
  };
  /** Puts a moved card back: into its column at its old place, or, from an automatic column, into its old status. */
  const undoMove = (itemId: string, undo: UndoMove, landed: Pick<SpaceItem, "columnId" | "completedAt">) => {
    undoToast?.dismiss();
    undoToast = undefined;
    const now = findItemLocation(itemId);
    const from = getBucketByKey(undo.bucketKey);
    // Only while the card is still where the move put it: after another change, this undo would undo that change too.
    if (!now || now.item.columnId !== landed.columnId || Boolean(now.item.completedAt) !== Boolean(landed.completedAt)) {
      toast(t.undoStale, { title: t.undoStaleTitle });
      return;
    }
    const target =
      from?.kind === "column" ? from : buckets().find((bucket) => bucket.kind === "column" && bucket.columnId === undo.columnId);
    if (!target) {
      toast(t.undoStale, { title: t.undoStaleTitle });
      return;
    }
    const sameColumn = now.bucket.key === target.key;
    const rawIndex = from?.kind !== "column" ? 0 : sameColumn && undo.index > now.index ? undo.index + 1 : undo.index;
    const intent = columnDropIntent(itemId, target.key, rawIndex);
    if (intent && !isNoOpMove(itemId, intent)) void dropCard(itemId, intent, null, null);
  };
  /** One "Undo" at a time: the next move replaces the toast of the last one. */
  let undoToast: ToastHandle | undefined;
  const showMoved = (moved: SpaceItem, message: string, undo: UndoMove | null) => {
    undoToast?.dismiss();
    const landed = { columnId: moved.columnId, completedAt: moved.completedAt };
    undoToast = toast(message, {
      title: t.movedTitle,
      ...(undo ? { action: { label: t.undo, variant: "ghost" as const, onClick: () => undoMove(moved.id, undo, landed) } } : {}),
    });
  };
  onCleanup(() => undoToast?.dismiss());

  /** Set once the board runs in the browser, so a test or a script knows its controls answer. */
  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => {
    setHydrated(true);
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

  const moveMutation = mutations.create<
    SpaceItem,
    { itemId: string; intent: DropIntent; claim: ClaimFields; undo: UndoMove | null },
    MoveContext
  >({
    onBefore: ({ itemId, intent, claim, undo }) => {
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
        undo,
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
        setBuckets((current) => {
          // A write omits reactions; keep the last summary if the card leaves the loaded pages.
          const previous = current.flatMap((bucket) => bucket.items).find((item) => item.id === updated.id);
          const item = { ...updated, reactions: updated.reactions ?? (previous ? cardReactions(previous) : undefined) };
          return current.map((bucket) => {
            const hadItem = bucket.items.some((item) => item.id === updated.id);
            const nextItems = bucket.items.filter((item) => item.id !== updated.id);
            let delta = hadItem ? -1 : 0;

            if (bucket.key === ctx?.targetBucketKey) {
              const insertIndex = clamp(ctx.targetIndex, 0, nextItems.length);
              nextItems.splice(insertIndex, 0, item);
              delta += 1;
            }

            return { ...bucket, items: nextItems, ...shiftTotals(bucket, delta) };
          });
        });
      });
      // Every move says where the card went and offers "Undo" (K7); an undo itself says only where it went back to.
      if (ctx)
        showMoved(
          updated,
          ctx.gatheredBy === "blocked"
            ? t.movedStaysBlocked({ status: ctx.targetLabel })
            : ctx.gatheredBy === "overdue"
              ? t.movedStaysOverdue({ status: ctx.targetLabel })
              : t.cardMoved({ item: updated.title, column: ctx.targetLabel }),
          ctx.undo,
        );
      refreshBoard(t.moveRefreshFailed);
    },
    onError: (error, ctx) => {
      if (ctx) {
        // Show the columns Spaces holds rather than the board from before the drop: that board can
        // still show a neighbor someone else moved or deleted, and every retry would name it again.
        // The refresh is best effort; the failed move is the error to report.
        withBoardScrollPreserved(() => {
          setOptimisticBuckets(null);
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
  const dropCard = async (itemId: string, intent: DropIntent, undo: UndoMove | null, focusIn: string | null) => {
    const resolved = intent.kind === "column" ? resolveMoveTargets({ itemId, bucketKey: intent.bucketKey }) : null;
    const completed = resolved?.targetBucket.isDone ?? false;
    const claim =
      resolved && completed !== Boolean(resolved.source.item.completedAt)
        ? await resolveCompletionClaim(resolved.source.item.claim, props.currentUserId, completed, t)
        : {};
    if (!claim || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
    const saved = moveMutation.mutate({ itemId, intent, claim, undo });
    // After a keyboard drop the card's grip takes the focus back once the board shows the card in its place, or the
    // strip of the folded column it went into; unless the person moved on meanwhile.
    if (focusIn) {
      // The redraw can come frames later, inside a view transition; watch for a while and stop at the next move.
      const restore = (attempt = 0) => {
        if (attempt > 30) return;
        if (!document.activeElement || document.activeElement === document.body) {
          (
            boardScrollContainer?.querySelector<HTMLElement>(`[data-sortable-handle="${CSS.escape(itemId)}"]`) ??
            boardScrollContainer?.querySelector<HTMLElement>(`[data-spaces-kanban-fold="${CSS.escape(focusIn)}"]`)
          )?.focus({ preventScroll: true });
        } else if (!boardScrollContainer?.contains(document.activeElement)) return;
        requestAnimationFrame(() => restore(attempt + 1));
      };
      requestAnimationFrame(() => restore());
    }
    await saved;
  };

  /** A transfer ends the claim: the holder's own ends without a question, someone else's is taken over after one. */
  const dropOnWormhole = async (itemId: string, wormholeId: string) => {
    const claim = await resolveTransferClaim(findItemLocation(itemId)?.item.claim, props.currentUserId, t);
    if (!claim || movingItemId() || moveMutation.loading() || transferMutation.loading()) return;
    await transferMutation.mutate({ itemId, wormholeId, claim });
  };

  type Transfer = { itemId: string; wormholeId: string; claim: ClaimFields };
  const transferMutation = mutations.create<WormholeTransferResult, Transfer, TransferContext>({
    onBefore: ({ itemId }) => {
      const source = findItemLocation(itemId);
      if (!source) throw new Error(t.itemUnavailable);
      if (!canTransferThroughWormhole(source.item)) throw new Error(t.recurringWormholeBlocked);
      const previousBuckets = buckets();

      withBoardScrollPreserved(() => {
        setBuckets((current) =>
          current.map((bucket) => {
            const hadItem = bucket.items.some((item) => item.id === itemId);
            return hadItem ? { ...bucket, items: bucket.items.filter((item) => item.id !== itemId), ...shiftTotals(bucket, -1) } : bucket;
          }),
        );
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
          setBuckets(context.previousBuckets);
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
      if (item.assignees?.some((assignee) => assignee.kind === "user" && assignee.id === props.currentUserId)) return item;
      const response = await apiClient[":id"].items[":itemId"].$patch({
        param: { id: props.spaceId, itemId: item.id },
        json: { addAssigneeIds: [props.currentUserId] },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.assignToMeFailed));
      return response.json();
    },
    onSuccess: (item) => {
      const alreadyAssigned = findItemLocation(item.id)?.item.assignees?.some(
        (assignee) => assignee.kind === "user" && assignee.id === props.currentUserId,
      );
      setBuckets((current) =>
        current.map((bucket) => ({
          ...bucket,
          items: bucket.items.map((candidate) =>
            candidate.id === item.id ? { ...item, reactions: item.reactions ?? cardReactions(candidate) } : candidate,
          ),
        })),
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

  /**
   * On a card's grip, the arrow keys walk the board as on the card, until Space lifts the card: the engine's quick step,
   * which moves a row at once, would move a card for someone who only wants to go to the next one.
   */
  const handleGripKeyDown = (event: KeyboardEvent) => {
    const grip = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-sortable-handle]") : null;
    if (!grip || dragStatus() || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[event.key] as
      | "up"
      | "down"
      | "left"
      | "right"
      | undefined;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    event.stopPropagation();
    if (!direction) return;
    grip.closest("article")?.querySelector<HTMLElement>("[data-spaces-kanban-card]")?.focus({ preventScroll: true });
    navigateCards(direction);
  };
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
        ?.querySelector<HTMLElement>(
          `[data-spaces-kanban-fold="${CSS.escape(bucketKey)}"], [data-spaces-kanban-column-menu="${CSS.escape(bucketKey)}"]`,
        )
        ?.focus({ preventScroll: true }),
    );
  };
  const ColumnCount = (countProps: { bucket: KanbanBucketInitial }) => (
    <span class="spaces-kanban-lane__count" title={countLabel(countProps.bucket)}>
      <span aria-hidden="true">{countText(countProps.bucket)}</span>
      <span class="sr-only">{countLabel(countProps.bucket)}</span>
    </span>
  );

  const statusColumns = () => buckets().filter((bucket) => bucket.kind === "column");
  /** A recurring task cannot go through a wormhole, so the wormholes refuse it while it is dragged. */
  const wormholeTakesDragged = () => {
    const dragged = draggedItemId();
    const source = dragged === null ? null : findItemLocation(dragged);
    return !source || canTransferThroughWormhole(source.item);
  };
  /** "Move to ▸" and "Move to another Space ▸" in a card's menu: the way to move on a phone, and a second way everywhere. */
  const cardMenu = (item: SpaceItem, bucketKey: string): DropdownSection[] => {
    const columns = statusColumns()
      .filter((bucket) => bucket.key !== bucketKey && !(bucket.columnId === item.columnId && getBucketByKey(bucketKey)?.kind !== "column"))
      .map((bucket) => ({ label: bucket.label, action: () => moveCard(item.id, bucket.key, 0) }));
    const spaces = canTransferThroughWormhole(item)
      ? props.wormholes.flatMap((wormhole) =>
          wormhole.target
            ? [
                {
                  label: `${wormhole.target.spaceName} · ${wormhole.target.columnName}`,
                  action: () => void dropOnWormhole(item.id, wormhole.id),
                },
              ]
            : [],
        )
      : [];
    // On a phone the claim stands here too, where the card shows no buttons but its menu.
    const claimable = props.canWrite && !item.completedAt && !item.startsAt && !item.endsAt;
    const ownClaim = item.claim?.actor.id === props.currentUserId;
    const claim =
      claimable && (!item.claim || ownClaim)
        ? [
            {
              label: item.claim ? t.releaseClaim : t.imOnIt,
              icon: item.claim ? "ti ti-player-stop" : "ti ti-player-play",
              disabled: claimCardMutation.loading() || (!item.claim && item.activeBlockerCount > 0),
              action: () => void claimCardMutation.mutate(item),
            },
          ]
        : [];
    if (!columns.length && !(spaces.length && props.canWrite) && !claim.length) return [];
    return [
      {
        items: [
          ...claim,
          ...(columns.length ? [{ label: t.cardMoveTo, icon: "ti ti-arrows-right-left", submenu: [{ items: columns }] }] : []),
          ...(spaces.length && props.canWrite
            ? [{ label: t.cardMoveToSpace, icon: "ti ti-arrow-bounce", submenu: [{ items: spaces }] }]
            : []),
        ],
      },
    ];
  };
  // The route's status row shows the board's size and key figures, also after a move or a reload.
  createEffect(() =>
    props.onSummary?.(boardSummary(buckets(), { open: t.factOpen, overdue: t.factOverdue, blocked: t.factBlocked }, props.dateConfig)),
  );

  return (
    <div class="spaces-kanban flex h-full min-h-0 flex-col">
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
        on:keydown={{ handleEvent: handleGripKeyDown, capture: true }}
        onFocusIn={(event) => {
          setFocusedItemId(event.target.closest<HTMLElement>("[data-spaces-kanban-card]")?.dataset.itemId);
          setFocusedGrip(event.target.closest<HTMLElement>("[data-sortable-handle]")?.dataset.sortableHandle ?? null);
        }}
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
        class="spaces-kanban-board k2b-detail-trail k2b-quiet-scrollbar"
        data-hydrated={hydrated() ? "" : undefined}
        data-scroll-preserve={`spaces-kanban-board-${props.spaceId}`}
      >
        <div class="spaces-kanban-columns k2b-divided-inline">
          <For each={bucketKeys()}>
            {(key, bucketIndex) => {
              const bucket = createMemo<KanbanBucketInitial>((previous) => getBucketByKey(key) ?? previous, getBucketByKey(key)!);
              const itemIds = createMemo(() => bucket().items.map((item) => item.id));
              const kind = bucket().kind;
              const virtual = kind === "column" ? null : kind;
              // An automatic column takes no card from elsewhere: while one is dragged, it refuses the drop.
              const listDisabled = () => {
                if (!props.canWrite) return true;
                const dragged = draggedItemId();
                if (dragged === null || itemIds().includes(dragged)) return false;
                if (virtual !== null) return true;
                // A card from an automatic column already has an open status; dropping it on that status changes nothing.
                const source = findItemLocation(dragged);
                return !!source && source.bucket.kind !== "column" && !bucket().isDone && source.item.columnId === bucket().columnId;
              };
              const placement = virtual ? (id: string, from: string) => (from === key ? Math.max(itemIds().indexOf(id), 0) : 0) : undefined;
              const ColumnMark = () =>
                virtual ? (
                  <i class={`ti ${virtualColumnIcon[virtual]} spaces-kanban-lane__mark`} aria-hidden="true" />
                ) : (
                  <span class="spaces-kanban-lane__dot" style={`background-color:${bucketColor(bucket())}`} aria-hidden="true" />
                );
              /** The column's cards; a folded column keeps an empty list, so a card dropped on its strip lands at its top. */
              const Cards = (cardsProps: { folded: boolean }) => (
                <SortableList
                  group={group}
                  listKey={key}
                  label={bucket().label}
                  listLabel={bucket().label}
                  dragBy="row"
                  class="spaces-kanban-cards k2b-divided"
                  items={cardsProps.folded ? [] : bucket().items}
                  itemKey={(item) => item.id}
                  itemLabel={(item) => item.title}
                  itemIcon={() => "ti ti-checkbox"}
                  disabled={listDisabled()}
                  placement={placement}
                  onMove={(id, index, move) => moveFromEngine(key, id, index, move)}
                >
                  {(item, handle) => {
                    const id = item().id;
                    const priority = () => {
                      const value = item().priority;
                      return value ? priorityMeta[value] : null;
                    };
                    const isSelected = () => id === selectedItemId();
                    const tags = () => item().tags ?? [];
                    // In the Overdue column the column says it; elsewhere an overdue card says it instead of its date.
                    const overdue = () => virtual !== "overdue" && !item().completedAt && isTaskOverdue(item(), props.dateConfig);
                    const isMovingThis = () => (moveMutation.loading() || transferMutation.loading()) && movingItemId() === id;
                    const titleId = `spaces-kanban-card-title-${props.spaceId}-${key}-${id}`;
                    let cardLink: HTMLAnchorElement | undefined;
                    return (
                      <article
                        class="spaces-kanban-card k2b-progressive-row"
                        data-selected={isSelected() ? "" : undefined}
                        data-moving={isMovingThis() ? "" : undefined}
                        data-done={item().completedAt ? "" : undefined}
                      >
                        <span class="spaces-kanban-card__glyph" aria-hidden="true">
                          <Show
                            when={priority()}
                            fallback={<i class={`ti ${item().startsAt ? "ti-calendar-event" : "ti-point"} text-dimmed`} />}
                          >
                            {(meta) => <i class={`ti ${meta().icon} ${meta().color}`} />}
                          </Show>
                        </span>
                        {/* The grip serves the keyboard only, since the whole card drags; it shows on keyboard focus over the glyph. */}
                        <Show when={props.canWrite}>{handle}</Show>
                        <span id={titleId} class="spaces-kanban-card__title" title={item().title}>
                          {item().title}
                        </span>
                        <Show when={descriptionPreview(item().description)}>
                          {(preview) => <span class="spaces-kanban-card__desc">{preview()}</span>}
                        </Show>
                        <a
                          ref={cardLink}
                          data-spaces-kanban-card
                          data-bucket-key={key}
                          data-item-id={id}
                          class="spaces-kanban-card__link"
                          aria-keyshortcuts={props.canWrite ? "Enter M D" : "Enter"}
                          aria-describedby={cardMetaId(id)}
                          href={buildItemUrl(props.baseUrl, id)}
                          onClick={(event) => {
                            if (!shouldHandleDetailClick(event, event.currentTarget)) return;
                            event.preventDefault();
                            const href = buildItemUrl(props.baseUrl, id);
                            setSelectedItemId(id);
                            requestSpacesRouteNavigation(href, { scroll: "preserve" });
                          }}
                        >
                          {/* The link's name is the title; the visible title lies beside it, above the link's area. */}
                          <span class="sr-only">{item().title}</span>
                        </a>
                        {/* The metadata lies outside the link, so it describes the link; the reactions are their own controls. */}
                        <span class="spaces-kanban-card__meta" data-spaces-kanban-card-footer>
                          <span id={cardMetaId(id)} class="contents">
                            {/* In an automatic column the status is no longer the column, so the card names it. */}
                            <Show when={virtual && columnOf(item().columnId)}>
                              {(column) => (
                                <span
                                  data-spaces-kanban-card-status
                                  class="spaces-kanban-card__status"
                                  title={t.cardStatus({ status: column().name })}
                                >
                                  <span
                                    class="spaces-kanban-lane__dot"
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
                            <Show when={overdue()}>
                              <span data-spaces-kanban-card-overdue class="contents">
                                <StatusBadge tone="error" variant="dot" label={t.overdue} class="spaces-kanban-card__overdue" />
                              </span>
                            </Show>
                            <Show when={item().createdByWorkload}>
                              <span class="spaces-kanban-card__icon" title={t.createdByWorkload}>
                                <i class="ti ti-code" role="img" aria-label={t.createdByWorkload} />
                              </span>
                            </Show>
                            <Show when={item().deadline && !overdue()}>
                              <span class="spaces-kanban-card__date">{formatDeadline(item().deadline!, props.dateConfig)}</span>
                            </Show>
                            <Show when={tags()[0]}>
                              {(tag) => (
                                <Tag color={tag().color} class="spaces-kanban-card__tag">
                                  {tag().name}
                                </Tag>
                              )}
                            </Show>
                            <Show when={tags().length > 1}>
                              <span class="spaces-kanban-card__more">+{tags().length - 1}</span>
                            </Show>
                            <Show when={isInactiveTask(item())}>
                              <span class="spaces-kanban-card__inactive" title={t.inactiveFor({ days: INACTIVE_ITEM_DAYS })}>
                                <i class="ti ti-clock-pause" aria-hidden="true" />
                                {t.inactive}
                              </span>
                            </Show>
                          </span>
                          <Show when={(cardReactions(item())?.length ?? 0) > 0 || props.canWrite}>
                            <ItemReactions
                              spaceId={props.spaceId}
                              itemId={id}
                              reactions={cardReactions(item())}
                              canReact={props.canWrite}
                              picker={reactionPicker}
                              retryToast={retryToast}
                              density="compact"
                              add="progressive"
                              max={3}
                              focusFallback={() => cardLink}
                              class="spaces-card-reactions"
                            />
                          </Show>
                        </span>
                        <span class="spaces-kanban-card__people">
                          <AssigneeAvatars
                            assignees={item().assignees ?? []}
                            claim={item().claim}
                            currentUserId={props.currentUserId}
                            max={3}
                          />
                        </span>
                        <Show when={props.canWrite}>
                          {/* On touch, the buttons' hit areas reach past this box on purpose; the layout self-check skips it. */}
                          <span class="spaces-kanban-card__tools" data-layout-check="skip">
                            <Show when={isMovingThis()}>
                              <i class="ti ti-loader-2 animate-spin spaces-kanban-card__busy" aria-hidden="true" />
                            </Show>
                            <Show when={!item().completedAt && !item().startsAt && !item().endsAt}>
                              <span class={item().claim ? "" : "k2b-progressive-action"}>
                                <ClaimButton
                                  claim={item().claim}
                                  currentUserId={props.currentUserId}
                                  canTakeOver={false}
                                  compact
                                  loading={claimingItemId() === id}
                                  disabled={claimCardMutation.loading() || (!item().claim && item().activeBlockerCount > 0)}
                                  class="h-6 w-6"
                                  onClaim={() => void claimCardMutation.mutate(item())}
                                  onRelease={() => void claimCardMutation.mutate(item())}
                                  onTakeOver={() => undefined}
                                />
                              </span>
                            </Show>
                            <Show when={cardMenu(item(), key).length > 0}>
                              <span class="k2b-progressive-action">
                                <Dropdown.Root items={cardMenu(item(), key)} label={t.cardActions({ title: item().title })}>
                                  <Dropdown.Trigger
                                    iconOnly
                                    size="xs"
                                    variant="ghost"
                                    class="h-6 w-6 text-dimmed"
                                    label={t.cardActions({ title: item().title })}
                                    data-spaces-kanban-card-menu={id}
                                  >
                                    <i class="ti ti-dots text-sm" aria-hidden="true" />
                                  </Dropdown.Trigger>
                                </Dropdown.Root>
                              </span>
                            </Show>
                          </span>
                        </Show>
                      </article>
                    );
                  }}
                </SortableList>
              );

              return (
                <Show
                  when={!props.folded.has(key)}
                  fallback={
                    // A folded column stays a target: a card dropped on its strip lands at the top of the column.
                    <section data-spaces-kanban-column={key} data-sortable-column class="spaces-kanban-strip">
                      <button
                        type="button"
                        data-spaces-kanban-fold={key}
                        data-sortable-column-head
                        aria-expanded="false"
                        aria-label={t.unfoldColumn({ column: bucket().label, count: countLabel(bucket()) })}
                        title={t.unfoldColumn({ column: bucket().label, count: countLabel(bucket()) })}
                        onClick={() => toggleFolded(key)}
                        class="spaces-kanban-strip__button"
                        data-spaces-kanban-no-drop={listDisabled() && draggedItemId() ? "" : undefined}
                      >
                        <ColumnMark />
                        <span class="spaces-kanban-strip__count" aria-hidden="true">
                          {countText(bucket())}
                        </span>
                        <span class="spaces-kanban-strip__label" aria-hidden="true">
                          {bucket().label}
                        </span>
                      </button>
                      <Cards folded />
                    </section>
                  }
                >
                  <section
                    data-spaces-kanban-column={key}
                    data-sortable-column
                    data-virtual={virtual ?? undefined}
                    data-spaces-kanban-no-drop={listDisabled() && draggedItemId() ? "" : undefined}
                    aria-labelledby={`spaces-kanban-column-${props.spaceId}-${key}`}
                    class="spaces-kanban-lane"
                  >
                    <header class="spaces-kanban-lane__head k2b-progressive-row" data-sortable-column-head>
                      <Show when={virtual} fallback={<ColumnMark />}>
                        {(kind) => (
                          <Tooltip.Anchor content={kind() === "blocked" ? t.blockedColumnHelp : t.overdueColumnHelp}>
                            <span class="inline-flex">
                              <ColumnMark />
                            </span>
                          </Tooltip.Anchor>
                        )}
                      </Show>
                      <h3 id={`spaces-kanban-column-${props.spaceId}-${key}`} class="spaces-kanban-lane__name">
                        {bucket().label}
                        <Show when={virtual}>
                          {(kind) => <span class="sr-only">. {kind() === "blocked" ? t.blockedColumnHelp : t.overdueColumnHelp}</span>}
                        </Show>
                      </h3>
                      <ColumnCount bucket={bucket()} />
                      <Show when={listDisabled() && draggedItemId()}>
                        <span class="spaces-kanban-lane__refuse">{t.virtualColumnNoDrop}</span>
                      </Show>
                      <span class="spaces-kanban-lane__tools" data-layout-check="skip">
                        <Dropdown.Root
                          position="bottom-left"
                          items={[
                            {
                              label: t.foldColumn({ column: bucket().label }),
                              icon: "ti ti-viewport-narrow",
                              action: () => toggleFolded(key),
                            },
                            ...(props.canWrite
                              ? [
                                  {
                                    label: t.moveColumnLeft,
                                    icon: "ti ti-arrow-left",
                                    disabled: bucketIndex() === 0 || reorderColumnsMutation.loading(),
                                    action: () => {
                                      moveColumn(key, bucketIndex() - 1);
                                      focusColumnMenu(key);
                                    },
                                  },
                                  {
                                    label: t.moveColumnRight,
                                    icon: "ti ti-arrow-right",
                                    disabled: bucketIndex() === buckets().length - 1 || reorderColumnsMutation.loading(),
                                    action: () => {
                                      moveColumn(key, bucketIndex() + 2);
                                      focusColumnMenu(key);
                                    },
                                  },
                                ]
                              : []),
                          ]}
                        >
                          <Dropdown.Trigger
                            iconOnly
                            size="xs"
                            variant="ghost"
                            class="h-6 w-6 text-dimmed"
                            label={t.columnActions({ column: bucket().label })}
                            data-spaces-kanban-column-menu={key}
                          >
                            <i class="ti ti-dots text-sm" aria-hidden="true" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </span>
                    </header>

                    <div
                      class="spaces-kanban-lane__body k2b-quiet-scrollbar"
                      data-scroll-preserve={`spaces-kanban-column-${props.spaceId}-${key}`}
                    >
                      <Cards folded={false} />
                      <Show when={bucket().items.length === 0}>
                        <p class="spaces-kanban-lane__empty">
                          {bucket().unfilteredTotal
                            ? t.noMatchingItems
                            : virtual === "blocked"
                              ? t.blockedColumnHelp
                              : virtual === "overdue"
                                ? t.overdueColumnHelp
                                : t.noItems}
                        </p>
                      </Show>
                      <Show when={bucketQuery(key)?.hasMore()}>
                        <button
                          type="button"
                          class="spaces-kanban-lane__row"
                          onClick={() => void bucketQuery(key)?.loadMore()}
                          disabled={bucketQuery(key)?.loadingMore()}
                          aria-label={t.loadMoreIn({ group: bucket().label })}
                        >
                          <i
                            class={`ti ${bucketQuery(key)?.loadingMore() ? "ti-loader-2 animate-spin" : "ti-arrow-down"}`}
                            aria-hidden="true"
                          />
                          {t.loadMore}
                        </button>
                      </Show>
                      <Show when={bucketQuery(key)?.error()}>
                        {(error) => (
                          <div class="spaces-kanban-lane__error" role="alert">
                            <i class="ti ti-alert-circle" aria-hidden="true" />
                            <span>{error().message}</span>
                            <button type="button" class="spaces-kanban-lane__link" onClick={() => void bucketQuery(key)?.refresh()}>
                              {t.reloadView}
                            </button>
                          </div>
                        )}
                      </Show>
                      <Show when={props.canWrite && bucket().columnId}>
                        <div class="spaces-kanban-lane__add">
                          <CreateItemButton
                            spaceId={props.spaceId}
                            columns={props.columns}
                            tags={props.tags}
                            templates={props.templates}
                            dateConfig={props.dateConfig}
                            variant="inline"
                            defaultType="task"
                            defaultColumnId={bucket().columnId!}
                          />
                        </div>
                      </Show>
                    </div>
                  </section>
                </Show>
              );
            }}
          </For>

          <Show when={showWormholes()}>
            <section class="spaces-kanban-lane" data-spaces-kanban-wormholes>
              <header class="spaces-kanban-lane__head">
                <i class="ti ti-arrow-bounce spaces-kanban-lane__mark" aria-hidden="true" />
                <h3 class="spaces-kanban-lane__name">{t.wormholes}</h3>
                <Tooltip.Anchor content={t.wormholesHelp}>
                  <IconButton label={t.aboutWormholes} size="xs" variant="ghost" class="h-6 w-6 text-dimmed">
                    <i class="ti ti-info-circle text-sm" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              </header>
              <div class="spaces-kanban-lane__body k2b-divided k2b-quiet-scrollbar">
                <For each={props.wormholes}>
                  {(wormhole) => (
                    <Show when={wormhole.target} keyed>
                      {(target) => (
                        <DropTarget
                          accept={[dragType]}
                          label={t.moveItemTo({ spaceName: target.spaceName, columnName: target.columnName })}
                          disabled={!props.canWrite || moveMutation.loading() || transferMutation.loading() || !wormholeTakesDragged()}
                          onDrop={(payload) => void dropOnWormhole(payload.value, wormhole.id)}
                          class="spaces-kanban-wormhole"
                        >
                          <i class="ti ti-arrow-bounce spaces-kanban-wormhole__icon" style={`color:${wormhole.color}`} aria-hidden="true" />
                          <span class="spaces-kanban-wormhole__name">{target.spaceName}</span>
                          <span class="spaces-kanban-wormhole__column">{target.columnName}</span>
                        </DropTarget>
                      )}
                    </Show>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </div>
      </div>
      {reactionPicker.popover()}
    </div>
  );
}
