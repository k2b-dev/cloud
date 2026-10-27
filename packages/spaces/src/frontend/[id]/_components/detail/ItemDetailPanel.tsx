import { useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  announce,
  Button,
  ButtonLink,
  DateTimePicker,
  DescriptionList,
  type DescriptionListItem,
  DetailPanel,
  type DropdownItem,
  IconButton,
  IconButtonLink,
  MarkdownView,
  MultiSelectInput,
  NumberInput,
  prompts,
  Select,
  StatusBadge,
  Tag,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import {
  isPlayableVideoType,
  type SpaceColumn,
  type SpaceItem,
  type SpaceItemAssignee,
  type SpaceItemClaim,
  type SpaceTag,
  type SpaceTaskDependency,
  type SpaceTaskDependent,
  type SpaceWormhole,
  type WormholeTransferResult,
} from "@/contracts";
import { deadlineDayKey, formatDeadline, isDateOnlyDeadline } from "@/presentation/deadline";
import { summarizeRecurrence } from "@/presentation/recurrence";
import { spaceCommandMessages } from "../../../../commands";
import { shouldHandleDetailClick } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import ClaimButton from "../shared/claim/ClaimButton";
import {
  type ClaimFields,
  claimTask,
  promptReleaseNote,
  releaseTask,
  resolveAssigneeClaim,
  resolveCompletionClaim,
  resolveTransferClaim,
  takeOverTask,
} from "../shared/claim/claim";
import { setItemCompleted } from "../shared/completion";
import { openEditItemDialog } from "../shared/editItem";
import { DEADLINE_DEFAULT_TIME, deadlinePresets } from "../shared/item-form/date";
import ItemReactions, { createReactionPicker } from "../shared/reactions/ItemReactions";
import SpaceAssigneePicker from "../shared/SpaceAssigneePicker";
import {
  invalidateSpacesData,
  requestSpacesRouteNavigation,
  shouldInvalidateSpacesDetail,
  subscribeToSpacesDataInvalidation,
} from "../workspace/workspace-events";
import type { SpaceItemDetail } from "../workspace/workspace-types";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import CommentsSection from "./CommentsSection";
import DependencyList from "./DependencyList";
import EventInvitations from "./EventInvitations";
import ItemLinksSection from "./ItemLinksSection";
import TaskAttachmentsSection from "./TaskAttachmentsSection";
import TaskChecklistSection from "./TaskChecklistSection";

type Props = {
  item: SpaceItem;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  wormholes: SpaceWormhole[];
  spaceId: string;
  /** Base URL for close link */
  baseUrl: string;
  /** Current user ID for comment editing */
  currentUserId: string;
  /** Newest bounded comments page rendered with the detail snapshot. */
  initialCommentsPage: SpaceItemDetail["comments"];
  commentTarget: SpaceItemDetail["commentTarget"];
  recurringContext: SpaceItemDetail["recurringContext"];
  references?: SpaceItemDetail["references"];
  links?: SpaceItemDetail["links"];
  work?: SpaceItemDetail["work"];
  attachments?: SpaceItemDetail["attachments"];
  checklist?: SpaceItemDetail["checklist"];
  blockedBy?: SpaceTaskDependency[];
  blocks?: SpaceTaskDependent[];
  dateConfig?: DateContext;
  canWrite: boolean;
  mailIntegrationAvailable: boolean;
  scrollPreserveKey: string;
};

// =============================================================================
// Constants
// =============================================================================

const formatEstimatedDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainder === 0) return `${hours} h`;
  return `${hours} h ${remainder} min`;
};

// =============================================================================
// Helper Components
// =============================================================================

function IconActionButton(props: { icon: string; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Tooltip.Anchor content={props.title}>
      <IconButton
        label={props.title}
        size="sm"
        onClick={props.onClick}
        disabled={props.disabled}
        class={`h-7 w-7 ${props.danger ? "hover:text-red-600 dark:hover:text-red-400" : ""}`}
      >
        <i class={props.icon} aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}

/** One assignee list, with the account working on the task first and marked as working. */
function AssigneesSection(props: {
  spaceId: string;
  assignees: SpaceItemAssignee[];
  claim?: SpaceItemClaim | null;
  currentUserId: string;
  dateConfig?: DateContext;
  onUpdate: (ids: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const t = useSpaceMessages();
  return (
    <SpaceAssigneePicker
      spaceId={props.spaceId}
      value={() => props.assignees}
      onChange={(next) => props.onUpdate(next.map((assignee) => assignee.id))}
      disabled={props.loading || props.disabled}
      variant="rows"
      placeholder={t.searchPeople}
      claim={props.claim}
      currentUserId={props.currentUserId}
      dateConfig={props.dateConfig}
    />
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Item detail panel with inline editing.
 * All edits are saved immediately via API.
 */
/** "today", "tomorrow", "in 3 days" for a date-only deadline, counted in whole days from today in the app timezone. */
const daysAway = (deadline: string, dateConfig: DateContext | undefined, locale: string): string => {
  const day = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  const today = deadlineDayKey(dates.today(dateConfig).toISOString(), dateConfig);
  const days = Math.round((day(deadline) - day(today)) / 86_400_000);
  const format = new Intl.RelativeTimeFormat(dateConfig?.locale ?? locale, { numeric: "auto" });
  return Math.abs(days) < 7 ? format.format(days, "day") : format.format(Math.round(days / 7), "week");
};

export default function ItemDetailPanel(props: Props) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
  const reactionPicker = createReactionPicker();
  const priorityOptions = [
    { value: "urgent", label: t.urgent, icon: "ti ti-alert-circle", color: "#ef4444" },
    { value: "high", label: t.high, icon: "ti ti-arrow-up", color: "#f97316" },
    { value: "medium", label: t.medium, icon: "ti ti-minus", color: "#eab308" },
    { value: "low", label: t.low, icon: "ti ti-arrow-down", color: "#3b82f6" },
  ] as const;
  const reconcileAfterWrite = (): void =>
    void invalidateSpacesData().catch(() => retryToast(t.itemRefreshFailed, t.retry, reconcileAfterWrite));

  const addBlocker = mutations.create<void, string>({
    mutation: async (blockerItemId, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].blockers.$post(
        { param: { id: props.spaceId, itemId: props.item.id }, json: { blockerItemId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.addBlockerFailed));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: (error) => toast.error(error.message),
  });

  const removeBlocker = mutations.create<void, string>({
    mutation: async (blockerItemId, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].blockers.$delete(
        { param: { id: props.spaceId, itemId: props.item.id }, json: { blockerItemId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.removeBlockerFailed));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: (error) => toast.error(error.message),
  });

  const blockerOptions = async (search: string, signal: AbortSignal) => {
    const response = await apiClient[":id"].items.filter.$post(
      {
        param: { id: props.spaceId },
        json: {
          type: "task",
          status: "all",
          search,
          sort: "updated",
          sortDesc: true,
          groupBy: "none",
          page: 1,
          pageSize: 50,
        },
      },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readResponseError(response, t.searchTasksFailed));
    const excluded = new Set([props.item.id, ...(props.blockedBy ?? []).map((dependency) => dependency.blocker.id)]);
    return (await response.json()).items
      .filter((item) => !excluded.has(item.id))
      .map((item) => ({
        id: item.id,
        label: item.title,
        description: item.completedAt ? t.completed : t.active,
        icon: item.completedAt ? "ti-circle-check" : "ti-checkbox",
      }));
  };

  const isGeneratedOccurrence = () => Boolean(props.recurringContext && !props.recurringContext.isOverride);
  // A memo, so a refreshed item snapshot that keeps the permission does not rebuild the property rows' controls and
  // take focus from them.
  const canEditItem = createMemo(() => props.canWrite && !isGeneratedOccurrence());
  const scheduleStart = () => props.recurringContext?.startsAt ?? props.item.startsAt;
  const scheduleEnd = () => props.recurringContext?.endsAt ?? props.item.endsAt;
  const seriesHref = () => {
    if (!props.recurringContext) return props.baseUrl;
    const url = new URL(props.baseUrl, "http://spaces.local");
    url.searchParams.set("item", props.recurringContext.seriesItemId);
    url.searchParams.delete("occurrence");
    return `${url.pathname}?${url.searchParams.toString()}`;
  };

  const patchItem = async (data: Record<string, unknown>) => {
    const res = await apiClient[":id"].items[":itemId"].$patch({
      param: { id: props.spaceId, itemId: props.item.id },
      json: data,
    });
    if (!res.ok) {
      throw new Error(await readResponseError(res, t.updateItemFailed));
    }
    return (await res.json()) as SpaceItem;
  };

  // Every edit shows its new value in the panel, so a save needs no confirmation.
  const handleItemUpdated = (item: SpaceItem | null) => {
    if (item) reconcileAfterWrite();
  };

  const loadCommentsPage = async (page: number, signal: AbortSignal) => {
    const res = await apiClient[":id"].items[":itemId"].comments.page.$get(
      {
        param: { id: props.spaceId, itemId: props.commentTarget.itemId },
        query: {
          page: String(page),
          per_page: String(props.initialCommentsPage.perPage),
          ...(props.commentTarget.recurrenceId ? { recurrence_id: props.commentTarget.recurrenceId } : {}),
        },
      },
      { init: { signal } },
    );
    if (!res.ok) throw new Error(await readResponseError(res, t.commentsRefreshFailed));
    return res.json();
  };

  const commentsSource = () => `${props.commentTarget.itemId}:${props.commentTarget.recurrenceId ?? "series"}`;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const commentsQuery = query.createInfinite<string, SpaceItemDetail["comments"], number>({
    source: commentsSource,
    initial: { source: commentsSource(), pages: [props.initialCommentsPage] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const page = cursor ?? 1;
      const result = await loadCommentsPage(page, abortSignal);
      if (result.page !== page) throw new Error(t.invalidCommentsPage);
      return result;
    },
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
    subscribe: ({ invalidate }) =>
      subscribeToSpacesDataInvalidation(["detail"], async ({ itemId }) => {
        while (!disposed) {
          if (!shouldInvalidateSpacesDetail(props.item.id, itemId) && !shouldInvalidateSpacesDetail(props.commentTarget.itemId, itemId))
            return;
          const requestedSource = commentsSource();
          try {
            await invalidate();
            return;
          } catch (error) {
            // Closing or replacing this editor removes its coverage obligation.
            if (disposed) return;
            if (requestedSource === commentsSource()) throw error;
          }
        }
      }),
  });
  const refreshComments = (): void =>
    void commentsQuery.invalidate().catch(() => retryToast(t.commentRefreshAfterSaveFailed, t.retry, refreshComments));
  const commentsPage = () => {
    const pages = commentsQuery.pages();
    const first = pages[0] ?? props.initialCommentsPage;
    const last = pages.at(-1) ?? first;
    const seen = new Set<string>();
    const items = pages
      .flatMap((page) => page.items)
      .filter((comment) => {
        if (seen.has(comment.id)) return false;
        seen.add(comment.id);
        return true;
      });
    return { ...last, items, total: Math.max(first.total, last.total) };
  };

  const updateMutation = mutations.create<SpaceItem, Record<string, unknown>>({
    mutation: patchItem,
    onSuccess: handleItemUpdated,
    onError: (err) => toast.error(err.message),
  });

  /**
   * One planning property edited in place. The row shows the new value at once and falls back to the previous
   * one when the write fails. Edits made while a save runs are not lost: the last one is saved next, so ticking
   * two tags in a row keeps both. A failed save drops the waiting edit with it.
   */
  const createPropertyEdit = <T,>(current: () => T, patch: (value: T) => Record<string, unknown>) => {
    const [value, setValue] = createSignal<T>(current());
    createEffect(() => {
      const next = current();
      setValue(() => next);
    });
    let saved = false;
    const mutation = mutations.create<SpaceItem, { next: T; previous: T }, { previous: T }>({
      onBefore: (intent) => ({ previous: intent.previous }),
      mutation: (intent) => patchItem(patch(intent.next)),
      onSuccess: (item) => {
        saved = true;
        handleItemUpdated(item);
      },
      onError: (err, context) => {
        if (context) setValue(() => context.previous);
        toast.error(err.message);
      },
      onAbort: (context) => {
        if (context) setValue(() => context.previous);
      },
    });
    const same = (left: T, right: T) => JSON.stringify(left) === JSON.stringify(right);
    let saving = false;
    let waiting: { next: T } | undefined;
    const update = async (next: T) => {
      if (saving) {
        waiting = { next };
        setValue(() => next);
        return;
      }
      let intent = { next, previous: value() };
      if (same(intent.next, intent.previous)) return;
      saving = true;
      try {
        for (;;) {
          saved = false;
          setValue(() => intent.next);
          await mutation.mutate(intent);
          const queued = waiting;
          waiting = undefined;
          if (!saved || !queued || same(queued.next, intent.next)) break;
          intent = { next: queued.next, previous: intent.next };
        }
      } finally {
        saving = false;
      }
    };
    return { value, update, loading: mutation.loading };
  };
  const deadlineEdit = createPropertyEdit(
    () => props.item.deadline,
    (deadline) => ({ deadline }),
  );
  const estimateEdit = createPropertyEdit(
    () => props.item.estimatedDurationMinutes,
    (estimatedDurationMinutes) => ({ estimatedDurationMinutes }),
  );
  // The picker reports any option value; the server validates it against the priority list.
  const priorityEdit = createPropertyEdit<string | null>(
    () => props.item.priority,
    (priority) => ({ priority }),
  );
  const tagsEdit = createPropertyEdit(
    () => props.item.tags?.map((tag) => tag.id) ?? [],
    (tagIds) => ({ tagIds }),
  );

  /**
   * Removing the person who works on the task ends their claim: your own at once, someone else's after one
   * confirmation. Declining changes nothing, and the answer belongs to the item the question named.
   */
  const updateAssignees = async (assigneeIds: string[]) => {
    const itemId = props.item.id;
    const claim = await resolveAssigneeClaim(props.item.claim, props.currentUserId, props.item.assignees ?? [], assigneeIds, t);
    if (claim && props.item.id === itemId) await updateMutation.mutate({ assigneeIds, ...claim });
  };

  type CompleteIntent = { itemId: string; completed: boolean } & ClaimFields;
  /**
   * Someone else's claim is taken over after one confirmation; declining changes nothing. The answer belongs to the
   * item the question named, so a panel that shows another item by then sends nothing.
   */
  const toggleCompleted = async () => {
    const itemId = props.item.id;
    const completed = !isCompleted();
    const claim = await resolveCompletionClaim(props.item.claim, props.currentUserId, completed, t);
    if (claim && props.item.id === itemId) await completeMutation.mutate({ itemId, completed, ...claim });
  };
  const completeMutation = mutations.create<boolean, CompleteIntent, { intent: CompleteIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async (intent) => {
      await setItemCompleted({ spaceId: props.spaceId, ...intent }, t.updateItemFailed);
      return intent.completed;
    },
    // The button shows the new state, but it was busy while saving and a shortcut never focused it, so a screen
    // reader is told.
    onSuccess: (completed) => {
      announce(completed ? t.itemCompleted : t.itemReopened);
      reconcileAfterWrite();
    },
    onError: (err, context) => retryToast(err.message, t.retry, () => context && completeMutation.mutate(context.intent)),
  });

  const claimMutation = mutations.create<string | null, "claim" | "release" | "take-over">({
    mutation: async (kind) => {
      const target = { spaceId: props.spaceId, itemId: props.item.id };
      const claim = props.item.claim;
      if (kind === "claim") {
        await claimTask(target, t);
        return t.youAreOnIt;
      }
      if (!claim) return null;
      if (kind === "release") {
        const note = await promptReleaseNote(t);
        if (note === null) return null;
        await releaseTask(target, claim.id, t, note);
        return t.claimReleased;
      }
      const confirmed = await prompts.confirm(t.takeOverHelp({ name: claim.displayName }), {
        title: t.takeOverTitle,
        icon: "ti ti-replace",
        confirmText: t.takeOverClaim,
        cancelText: t.cancel,
      });
      if (!confirmed) return null;
      await takeOverTask(target, claim, t);
      return t.claimTakenOver({ name: claim.displayName });
    },
    onSuccess: (message) => {
      if (!message) return;
      toast.success(message);
      reconcileAfterWrite();
    },
    onError: (err) => toast.error(err.message),
  });
  /** One header control: claim, release your own claim, or, as any writer may, take over somebody else's. */
  const claimButton = () => (
    <ClaimButton
      claim={props.item.claim}
      currentUserId={props.currentUserId}
      canTakeOver
      loading={claimMutation.loading()}
      disabled={isLoading() || isCompleted() || (!props.item.claim && completionBlocked())}
      onClaim={() => void claimMutation.mutate("claim")}
      onRelease={() => void claimMutation.mutate("release")}
      onTakeOver={() => void claimMutation.mutate("take-over")}
    />
  );

  const duplicateIntent = () => ({
    columnId: props.item.columnId,
    title: `${props.item.title} (Copy)`,
    description: props.item.description ?? undefined,
    startsAt: props.item.startsAt ?? undefined,
    endsAt: props.item.endsAt ?? undefined,
    deadline: props.item.deadline ?? undefined,
    estimatedDurationMinutes: props.item.estimatedDurationMinutes ?? undefined,
    priority: props.item.priority ?? undefined,
    assigneeIds: props.item.assignees?.map((a) => a.id),
    tagIds: props.item.tags?.map((t) => t.id),
  });
  const duplicateMutation = mutations.create<SpaceItem, ReturnType<typeof duplicateIntent>>({
    mutation: async (intent) => {
      const res = await apiClient[":id"].items.$post({
        param: { id: props.spaceId },
        json: intent,
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.duplicateItemFailed));
      return res.json();
    },
    onSuccess: () => {
      toast.success(t.itemDuplicated);
      reconcileAfterWrite();
    },
    onError: (err) => toast.error(err.message),
  });

  type DeleteIntent = { spaceId: string; itemId: string };
  const deleteMutation = mutations.create<void, DeleteIntent, { intent: DeleteIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ spaceId, itemId }) => {
      const res = await apiClient[":id"].items[":itemId"].$delete({
        param: { id: spaceId, itemId },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.deleteItemFailed));
    },
    onSuccess: (_, context) => {
      toast.success(t.itemDeleted);
      // A retry can succeed after the user opened another item; only the deleted item's panel closes.
      if (context?.intent.itemId === props.item.id) requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
      else reconcileAfterWrite();
    },
    onError: (err, context) => retryToast(err.message, t.retry, () => context && deleteMutation.mutate(context.intent)),
  });

  type Transfer = { itemId: string; wormholeId: string; claim: ClaimFields };
  const transferMutation = mutations.create<WormholeTransferResult, Transfer>({
    mutation: ({ itemId, wormholeId, claim }, context) =>
      transferThroughWormhole({
        sourceSpaceId: props.spaceId,
        itemId,
        wormholeId,
        claim,
        signal: context.abortSignal,
        locale: locale(),
      }),
    onSuccess: (result) => {
      showWormholeTransferToast(result, locale());
      requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
    },
    onError: (error) => {
      if (error.name !== "AbortError") toast.error(error.message);
    },
  });

  /** A transfer ends the claim; someone else's is taken over after one confirmation, as for completion. */
  const transferTo = async (wormholeId: string) => {
    const itemId = props.item.id;
    const claim = await resolveTransferClaim(props.item.claim, props.currentUserId, t);
    if (claim && props.item.id === itemId) await transferMutation.mutate({ itemId, wormholeId, claim });
  };

  const handleDuplicate = () => {
    if (!duplicateMutation.loading()) void duplicateMutation.mutate(duplicateIntent());
  };
  let deletePromptPending = false;
  const handleDelete = async () => {
    if (deletePromptPending || deleteMutation.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await prompts.confirm(t.deleteItemQuestion({ title: props.item.title }), {
        title: t.deleteItem,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t.delete,
      });
      if (confirmed) void deleteMutation.mutate({ spaceId: props.spaceId, itemId: props.item.id });
    } finally {
      deletePromptPending = false;
    }
  };

  // The dialog stays open until the save answers, so a failure shows in it with the input still there.
  let editPromptPending = false;
  const handleEdit = async () => {
    if (editPromptPending) return;
    editPromptPending = true;
    try {
      const saved = await openEditItemDialog({
        spaceId: props.spaceId,
        item: props.item,
        columns: props.columns,
        tags: props.tags,
        dateConfig: props.dateConfig,
        currentUserId: props.currentUserId,
      });
      if (saved) reconcileAfterWrite();
    } finally {
      editPromptPending = false;
    }
  };

  const isLoading = () =>
    updateMutation.loading() ||
    deadlineEdit.loading() ||
    estimateEdit.loading() ||
    priorityEdit.loading() ||
    tagsEdit.loading() ||
    completeMutation.loading() ||
    duplicateMutation.loading() ||
    deleteMutation.loading() ||
    transferMutation.loading() ||
    addBlocker.loading() ||
    removeBlocker.loading();

  const isEvent = () => Boolean(props.item.startsAt && props.item.endsAt);
  const isCompleted = () => !!props.item.completedAt;
  const completionBlocked = () => !isCompleted() && activeBlockerCount() > 0;
  createEffect(() => {
    if (!canEditItem() || isLoading()) return;
    const itemId = props.item.id;
    const title = props.item.title;
    const copy = spaceCommandMessages.resolve([locale()]).t;
    if (!completionBlocked())
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `spaces.${itemId}.complete`,
          title: isCompleted() ? t.reopen : copy.complete({ title }),
          description: isCompleted() ? copy.reopenDescription : copy.completeDescription,
          icon: "ti ti-checkbox",
          shortcut: "d",
          action: () => {
            if (props.item.id === itemId && canEditItem() && !isLoading() && !completionBlocked()) return toggleCompleted();
          },
        }),
      );
    onCleanup(
      registerContextAwareCommand({
        scope: "selection",
        id: `spaces.${itemId}.edit`,
        title: copy.edit({ title }),
        description: copy.editDescription,
        icon: "ti ti-edit",
        shortcut: "e",
        action: () => {
          if (props.item.id === itemId && canEditItem() && !isLoading()) return handleEdit();
        },
      }),
    );
    if (!props.item.assignees?.some((assignee) => assignee.kind === "user" && assignee.id === props.currentUserId))
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `spaces.${itemId}.assign`,
          title: t.assignFocusedItem,
          description: copy.assignDescription({ title }),
          icon: "ti ti-user-check",
          shortcut: "m",
          action: async () => {
            await updateMutation.mutate({
              assigneeIds: [...(props.item.assignees?.map((assignee) => assignee.id) ?? []), props.currentUserId],
            });
          },
        }),
      );
    if (!isEvent())
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `spaces.${itemId}.deadline`,
          title: copy.deadlineTitle,
          description: copy.deadlineDescription({ title }),
          icon: "ti ti-calendar",
          action: async () => {
            const result = await prompts.form({
              title: t.deadline,
              fields: {
                deadline: { type: "datetime", label: t.deadline, optionalTime: true, default: props.item.deadline ?? undefined },
              },
            });
            if (result && props.item.id === itemId && canEditItem()) await updateMutation.mutate({ deadline: result.deadline || null });
          },
        }),
      );
  });
  const recurrenceSummary = () =>
    summarizeRecurrence(props.item.recurrence, {
      startsAt: scheduleStart(),
      allDay: props.recurringContext?.allDay ?? props.item.allDay,
      dateConfig: props.dateConfig,
    });
  const cloudId = useCloudIdCopy();
  const itemActions = (): DropdownItem[] => {
    const actions: DropdownItem[] = [
      {
        label: t.editItem,
        icon: "ti ti-pencil",
        action: () => void handleEdit(),
      },
      {
        label: t.duplicateItem,
        icon: "ti ti-copy",
        action: handleDuplicate,
      },
    ];

    if (canTransferThroughWormhole(props.item) && props.wormholes.length > 0) {
      actions.push({
        items: props.wormholes.flatMap((wormhole) =>
          wormhole.target
            ? [
                {
                  label: t.moveTo({ space: wormhole.target.spaceName, column: wormhole.target.columnName }),
                  icon: "ti ti-arrow-bounce",
                  action: () => void transferTo(wormhole.id),
                },
              ]
            : [],
        ),
      });
    }

    actions.push({
      items: [
        {
          label: t.deleteItem,
          icon: "ti ti-trash",
          variant: "danger",
          action: handleDelete,
        },
      ],
    });
    return actions;
  };

  const selectedPriority = () => priorityOptions.find((option) => option.value === priorityEdit.value());

  const canShowAssignees = () => canEditItem() || (props.item.assignees?.length ?? 0) > 0;
  const canShowInvitations = () => isEvent() && canEditItem() && props.mailIntegrationAvailable;
  const activeBlockerCount = () => (props.blockedBy ?? []).filter((dependency) => !dependency.blocker.completedAt).length;
  /** Related tasks first, then the other Cloud resources. */
  const references = () => {
    const all = props.references ?? [];
    return [
      ...all.filter((reference) => reference.ref.type === "spaces.item"),
      ...all.filter((reference) => reference.ref.type !== "spaces.item"),
    ];
  };
  const itemHref = (itemId: string) => {
    const url = new URL(props.baseUrl, "http://spaces.local");
    url.searchParams.set("item", itemId);
    return `${url.pathname}${url.search}`;
  };
  const hasLinks = () => references().length > 0 || (props.links?.length ?? 0) > 0;
  const hasMedia = () =>
    props.attachments?.some((attachment) => attachment.kind === "image" || isPlayableVideoType(attachment.mimeType)) ?? false;
  const hasChecklist = () => (props.checklist?.length ?? 0) > 0;
  const column = () => props.columns.find((entry) => entry.id === props.item.columnId);
  const metaLine = () =>
    [column()?.name, t.createdOn({ date: dates.formatDate(props.item.createdAt, props.dateConfig) })].filter(Boolean).join(" · ");

  // Properties: who, when, how it is classified, then the task's dependencies. Editors change each property in place
  // through a plain control, so the whole row opens its picker; readers see the same values as text. The editable rows
  // are stable objects, so their controls stay mounted while the item snapshot refreshes.
  const assignedRow: DescriptionListItem = {
    term: t.assignedPeople,
    get description() {
      return (
        <AssigneesSection
          spaceId={props.spaceId}
          assignees={props.item.assignees ?? []}
          claim={isEvent() ? null : props.item.claim}
          currentUserId={props.currentUserId}
          dateConfig={props.dateConfig}
          onUpdate={(ids) => void updateAssignees(ids)}
          loading={isLoading()}
          disabled={!canEditItem()}
        />
      );
    },
  };
  const dueRow: DescriptionListItem = {
    term: t.due,
    get description() {
      // A deadline without a time names its day and how many days away it is; a timed one keeps date, time and span.
      const due = (deadline: string) => (
        <span>
          {isDateOnlyDeadline(deadline) ? formatDeadline(deadline, props.dateConfig) : dates.formatDateTime(deadline, props.dateConfig)}
          <span class="text-dimmed">
            {" · "}
            {isDateOnlyDeadline(deadline)
              ? daysAway(deadline, props.dateConfig, locale())
              : dates.formatTimeSpan(deadline, props.dateConfig)}
          </span>
        </span>
      );
      return canEditItem() ? (
        <DateTimePicker
          aria-label={t.due}
          appearance="plain"
          placeholder={t.noDeadline}
          value={deadlineEdit.value}
          onValueChange={(deadline) => void deadlineEdit.update(deadline)}
          renderValue={due}
          presets={deadlinePresets(props.dateConfig)}
          optionalTime
          defaultTime={DEADLINE_DEFAULT_TIME}
          dateConfig={props.dateConfig}
          clearable
        />
      ) : (
        due(props.item.deadline!)
      );
    },
  };
  const estimateRow: DescriptionListItem = {
    term: t.estimate,
    get description() {
      return canEditItem() ? (
        <NumberInput
          aria-label={t.estimate}
          appearance="plain"
          placeholder={t.noEstimate}
          suffix="min"
          min={1}
          max={2_147_483_647}
          allowNegative={false}
          formatValue={formatEstimatedDuration}
          value={estimateEdit.value}
          onValueCommit={(minutes) => void estimateEdit.update(minutes)}
        />
      ) : (
        formatEstimatedDuration(props.item.estimatedDurationMinutes!)
      );
    },
  };
  const priorityRow: DescriptionListItem = {
    term: t.priority,
    get description() {
      return canEditItem() ? (
        <Select
          aria-label={t.priority}
          appearance="plain"
          placeholder={t.noPriority}
          value={priorityEdit.value}
          options={priorityOptions.map((option) => ({ id: option.value, ...option }))}
          onValueChange={(priority) => void priorityEdit.update(priority)}
          clearable
        />
      ) : (
        <Show when={selectedPriority()}>
          {(priority) => (
            <span class="spaces-priority-value">
              <span class="spaces-priority-value__dot" style={{ "background-color": priority().color }} aria-hidden="true" />
              {priority().label}
            </span>
          )}
        </Show>
      );
    },
  };
  const tagsRow: DescriptionListItem = {
    term: t.tags,
    get description() {
      return canEditItem() ? (
        <MultiSelectInput
          aria-label={t.tags}
          appearance="plain"
          placeholder={t.addTagShort}
          placeholderIcon="ti ti-plus"
          searchPlaceholder={t.searchTags}
          value={tagsEdit.value}
          options={props.tags.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
          onValueChange={(tagIds) => void tagsEdit.update(tagIds)}
        />
      ) : (
        <div class="flex flex-wrap items-center gap-1 py-1.5">
          <For each={props.item.tags ?? []}>{(tag) => <Tag color={tag.color}>{tag.name}</Tag>}</For>
        </div>
      );
    },
  };
  const blockedByRow: DescriptionListItem = {
    term: t.blockedBy,
    get description() {
      return (
        <DependencyList
          kind="blocker"
          entries={(props.blockedBy ?? []).map((dependency) => dependency.blocker)}
          href={itemHref}
          onRemove={canEditItem() ? (id) => void removeBlocker.mutate(id) : undefined}
          removeDisabled={addBlocker.loading() || removeBlocker.loading()}
          footer={
            canEditItem() ? (
              <Select
                aria-label={t.addTaskBlocker}
                appearance="plain"
                placeholder={t.addBlockerShort}
                placeholderIcon="ti ti-plus"
                searchPlaceholder={t.blockerSearchPlaceholder}
                value={null}
                fetchData={blockerOptions}
                onValueChange={(id) => {
                  if (id) void addBlocker.mutate(id);
                }}
                disabled={addBlocker.loading() || removeBlocker.loading()}
              />
            ) : undefined
          }
        />
      );
    },
  };
  const blocksRow: DescriptionListItem = {
    term: t.blocks,
    get description() {
      return <DependencyList kind="dependent" entries={(props.blocks ?? []).map((dependency) => dependency.dependent)} href={itemHref} />;
    },
  };
  const showPriorityRow = () => canEditItem() || Boolean(selectedPriority());
  const showTagsRow = () => canEditItem() || (props.item.tags?.length ?? 0) > 0;
  const showBlockedByRow = () => !isEvent() && (canEditItem() || (props.blockedBy?.length ?? 0) > 0);
  const showBlocksRow = () => !isEvent() && (props.blocks?.length ?? 0) > 0;
  const showAssignedRow = () => canShowAssignees() || Boolean(!isEvent() && props.item.claim);
  const propertyItems = (): DescriptionListItem[] => {
    const schedule: DescriptionListItem[] = isEvent()
      ? [
          { term: t.start, description: dates.formatDateTime(scheduleStart()!, props.dateConfig) },
          { term: t.end, description: dates.formatDateTime(scheduleEnd()!, props.dateConfig) },
          { term: t.duration, description: dates.formatDuration(scheduleStart()!, scheduleEnd()!, props.dateConfig) },
          ...(recurrenceSummary()
            ? [
                {
                  term: t.repeatTerm,
                  description: (
                    <span class="inline-flex items-center gap-1 font-medium text-secondary">
                      <i class="ti ti-repeat text-dimmed" aria-hidden="true" />
                      {recurrenceSummary()}
                    </span>
                  ),
                },
              ]
            : []),
          ...(props.item.location ? [{ term: t.location, description: props.item.location }] : []),
          ...(props.item.url
            ? [
                {
                  term: t.url,
                  description: (
                    <a href={props.item.url} target="_blank" rel="noreferrer" class="link break-all">
                      {props.item.url}
                    </a>
                  ),
                },
              ]
            : []),
          ...(showAssignedRow() ? [assignedRow] : []),
        ]
      : [...(showAssignedRow() ? [assignedRow] : []), ...(canEditItem() || props.item.deadline ? [dueRow] : [])];
    return [
      ...schedule,
      ...(showTagsRow() ? [tagsRow] : []),
      ...(showPriorityRow() ? [priorityRow] : []),
      ...(!isEvent() && (canEditItem() || props.item.estimatedDurationMinutes) ? [estimateRow] : []),
      ...(showBlockedByRow() ? [blockedByRow] : []),
      ...(showBlocksRow() ? [blocksRow] : []),
    ];
  };

  const statusBadge = () =>
    isCompleted() ? (
      <StatusBadge tone="ok" icon="ti ti-circle-check" label={t.completed} />
    ) : completionBlocked() ? (
      <StatusBadge tone="warning" icon="ti ti-lock" label={t.blockedByCount({ count: activeBlockerCount() })} />
    ) : (
      <StatusBadge tone="neutral" icon="ti ti-circle" label={t.active} />
    );

  return (
    <div class="h-full min-h-0" style="view-transition-name: detail-panel">
      <DetailPanel>
        <DetailPanel.Header
          class="[view-transition-name:space-item-detail-header]"
          kind={
            <>
              <span>{isEvent() ? t.event : t.task}</span>
              {statusBadge()}
              <Show when={props.recurringContext}>
                <StatusBadge tone="neutral" icon="ti ti-repeat" label={t.thisOccurrence} />
              </Show>
              <Show when={!props.canWrite}>
                <StatusBadge tone="neutral" icon="ti ti-lock" label={t.readOnly} />
              </Show>
            </>
          }
          title={props.item.title}
          subtitle={metaLine()}
          menu={[...(canEditItem() ? itemActions() : []), ...cloudId.section({ type: "spaces.item", id: props.item.id })]}
          menuLabel={t.moreItemActions}
          actions={
            <IconButtonLink
              href={props.baseUrl}
              onClick={(event) => {
                if (!shouldHandleDetailClick(event, event.currentTarget)) return;
                event.preventDefault();
                requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
              }}
              size="sm"
              label={t.closeItemDetails}
              tooltip={t.closeDetails}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </IconButtonLink>
          }
          primaryActions={
            canEditItem() || props.recurringContext ? (
              <>
                <Show when={canEditItem()}>
                  <Button
                    type="button"
                    onClick={() => void toggleCompleted()}
                    disabled={isLoading() || completionBlocked()}
                    title={completionBlocked() ? t.completeBlockersFirst : undefined}
                    variant="subtle"
                    size="sm"
                    class="spaces-details-done"
                    data-blocked={completionBlocked() ? "" : undefined}
                  >
                    <i
                      class={`ti ${
                        completeMutation.loading()
                          ? "ti-loader-2 animate-spin"
                          : isCompleted()
                            ? "ti-arrow-back-up"
                            : completionBlocked()
                              ? "ti-lock"
                              : "ti-circle-check"
                      }`}
                      aria-hidden="true"
                    />
                    {/* The state badge above names the blockers; the button keeps its own name and says why it waits. */}
                    {isCompleted() ? t.reopen : t.markComplete}
                  </Button>
                  <Show when={!isEvent() && !isCompleted()}>{claimButton()}</Show>
                </Show>
                <Show when={props.recurringContext}>
                  <ButtonLink
                    href={seriesHref()}
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      if (!shouldHandleDetailClick(event, event.currentTarget)) return;
                      event.preventDefault();
                      requestSpacesRouteNavigation(seriesHref(), { scroll: "preserve" });
                    }}
                  >
                    <i class="ti ti-repeat" aria-hidden="true" /> {t.viewSeries}
                  </ButtonLink>
                </Show>
              </>
            ) : undefined
          }
        />

        <DetailPanel.Body scrollPreserveKey={props.scrollPreserveKey}>
          <Show when={propertyItems().length > 0}>
            <DetailPanel.Section
              title={t.properties}
              actions={
                canEditItem() ? (
                  <IconActionButton icon="ti ti-pencil" title={t.editItem} onClick={() => void handleEdit()} disabled={isLoading()} />
                ) : undefined
              }
            >
              <DescriptionList layout="rows" size="sm" items={propertyItems()} />
            </DetailPanel.Section>
          </Show>

          <Show when={props.item.description}>
            <DetailPanel.Section
              class="[view-transition-name:space-item-detail-description]"
              title={t.description}
              actions={
                canEditItem() ? (
                  <IconActionButton
                    icon="ti ti-pencil"
                    title={t.editDescription}
                    onClick={() => void handleEdit()}
                    disabled={isLoading()}
                  />
                ) : undefined
              }
            >
              <MarkdownView markdown={props.item.description!} headingScale="compact" class="text-sm" />
            </DetailPanel.Section>
          </Show>

          <Show when={!isEvent() && (canEditItem() || hasChecklist())}>
            <DetailPanel.Section
              title={t.checklist}
              meta={`${(props.checklist ?? []).filter((entry) => entry.completed).length}/${props.checklist?.length ?? 0}`}
            >
              <TaskChecklistSection
                spaceId={props.spaceId}
                itemId={props.item.id}
                entries={props.checklist ?? []}
                canWrite={canEditItem()}
                onChanged={reconcileAfterWrite}
              />
            </DetailPanel.Section>
          </Show>

          <Show when={canShowInvitations()}>
            <EventInvitations spaceId={props.spaceId} itemId={props.item.id} title={props.item.title} />
          </Show>

          <Show when={!isEvent() && props.work?.progress}>
            {(note) => (
              <DetailPanel.Section title={t.workProgress}>
                <MarkdownView markdown={note().content} headingScale="compact" class="text-sm" />
              </DetailPanel.Section>
            )}
          </Show>
          <Show when={!isEvent() && props.work?.result}>
            {(result) => (
              <DetailPanel.Section title={t.workResult}>
                <MarkdownView markdown={result().content} headingScale="compact" class="text-sm" />
                <Show when={result().commit}>
                  <code class="text-xs break-all">{result().commit}</code>
                </Show>
              </DetailPanel.Section>
            )}
          </Show>

          <Show when={canEditItem() || hasLinks()}>
            <ItemLinksSection
              spaceId={props.spaceId}
              itemId={props.item.id}
              references={references()}
              links={props.links ?? []}
              canEdit={canEditItem()}
              onChanged={reconcileAfterWrite}
            />
          </Show>

          <Show when={!isEvent() && (canEditItem() || hasMedia())}>
            <TaskAttachmentsSection
              spaceId={props.spaceId}
              itemId={props.item.id}
              attachments={props.attachments ?? []}
              canWrite={canEditItem()}
              onChanged={reconcileAfterWrite}
            />
          </Show>

          {/* The discussion starts with the item's reactions: no heading, no frame, every chip, and "Add reaction" at the end.
              A generated occurrence of a series is no item of its own and has none. */}
          <Show when={!isGeneratedOccurrence() && (canEditItem() || (props.item.reactions?.length ?? 0) > 0)}>
            <ItemReactions
              spaceId={props.spaceId}
              itemId={props.item.id}
              reactions={props.item.reactions}
              canReact={canEditItem()}
              picker={reactionPicker}
              retryToast={retryToast}
              density="default"
              add="always"
              class="spaces-item-reactions"
            />
          </Show>

          <Show when={props.canWrite || commentsPage().total > 0}>
            <CommentsSection
              spaceId={props.spaceId}
              itemId={props.commentTarget.itemId}
              recurrenceId={props.commentTarget.recurrenceId}
              comments={commentsPage().items}
              total={commentsPage().total}
              loading={commentsQuery.loading()}
              hasMore={commentsPage().hasNext}
              loadingMore={commentsQuery.loadingMore()}
              loadError={commentsQuery.error()?.message}
              onLoadMore={() => commentsQuery.loadMore()}
              onRetry={() => commentsQuery.refresh()}
              currentUserId={props.currentUserId}
              onUpdate={refreshComments}
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
            />
          </Show>

          <DetailPanel.Group title={isEvent() ? t.moreAboutEvent : t.moreAboutTask}>
            <DetailPanel.Section title={t.technicalDetails} collapsible summary={t.technicalSummary}>
              <DescriptionList
                layout="rows"
                size="sm"
                items={[
                  { term: t.created, description: dates.formatDateTime(props.item.createdAt, props.dateConfig) },
                  { term: t.updated, description: dates.formatDateTime(props.item.updatedAt, props.dateConfig) },
                  { term: "ID", description: <span class="break-all font-mono text-dimmed">{props.item.id}</span> },
                ]}
              />
            </DetailPanel.Section>
          </DetailPanel.Group>
        </DetailPanel.Body>
      </DetailPanel>
      {reactionPicker.popover()}
    </div>
  );
}
