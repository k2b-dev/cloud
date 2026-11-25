import { accessMemberEntries } from "@k2b/cloud/access/ui";
import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { announce, useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  confirm,
  DateInput,
  type Fact,
  Facts,
  Failed,
  Field,
  Inline,
  Input,
  Loading,
  Lookup,
  Menu,
  type MenuEntry,
  Pane,
  Popover,
  Prose,
  Row,
  Section,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { isPlayableVideoType, type SpaceDetail, type SpaceItem, type WormholeTransferResult } from "@/contracts";
import { deadlineDayKey, formatDeadline, isDateOnlyDeadline } from "@/presentation/deadline";
import { summarizeRecurrence } from "@/presentation/recurrence";
import { spaceCommandMessages } from "../../../../commands";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import { openTemplateDialog } from "../edit/TemplateDialog";
import { templateFromItem } from "../edit/template-from-item";
import { formatEstimate, itemPeople } from "../list/ItemRow";
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
import ItemReactions, { createReactionPicker } from "../shared/reactions/ItemReactions";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import type { SpaceItemDetail } from "../workspace/workspace-types";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import CommentsSection from "./CommentsSection";
import EventInvitations from "./EventInvitations";
import ItemHistorySection from "./ItemHistorySection";
import ItemLinksSection from "./ItemLinksSection";
import type { useItemDetailRoute } from "./item-detail-route";
import TaskAttachmentsSection from "./TaskAttachmentsSection";
import TaskChecklistSection from "./TaskChecklistSection";
import { useItemComments } from "./use-item-comments";

type Shared = {
  space: SpaceDetail;
  currentUserId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  mailIntegrationAvailable: boolean;
  /** Whether the edit form asks the assistant for a task estimate; decided on the server for this person. */
  estimateSuggestions?: boolean;
};

type Props = Shared & {
  route: ReturnType<typeof useItemDetailRoute>;
  spaceName: string;
  /** List, Table and Kanban step with J and K; the Calendar does not. */
  steppable: boolean;
};

/** "today", "tomorrow", "in 3 days" for a date-only deadline, counted in whole days from today in the app timezone. */
const daysAway = (deadline: string, dateConfig: DateContext | undefined, locale: string): string => {
  const day = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  const today = deadlineDayKey(dates.today(dateConfig).toISOString(), dateConfig);
  const days = Math.round((day(deadline) - day(today)) / 86_400_000);
  const format = new Intl.RelativeTimeFormat(dateConfig?.locale ?? locale, { numeric: "auto" });
  return Math.abs(days) < 7 ? format.format(days, "day") : format.format(Math.round(days / 7), "week");
};

/**
 * The open item beside a Space's view: on a wide screen a column, on the phone a page with one way back. The address
 * names it; while it loads or fails, its place says so, and J and K step to the next or previous row.
 */
export default function ItemDetailPane(props: Props) {
  const t = useSpaceMessages();
  const closeButton = () => (
    <Button variant="ghost" icon="x" label={t.closeItemDetails} href={props.route.baseHref()} onNavigate={() => props.route.close()} />
  );
  createEffect(() => {
    if (!props.steppable) return;
    // J and K step through the rows of the view, as the shortcuts of the page.
    for (const [key, direction] of [
      ["j", 1],
      ["k", -1],
    ] as const)
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `spaces.detail.${key}`,
          title: direction === 1 ? t.nextItem : t.previousItem,
          description: t.stepDescription,
          icon: direction === 1 ? "ti ti-arrow-down" : "ti ti-arrow-up",
          shortcut: key,
          action: () => void props.route.step(direction),
        }),
      );
  });
  return (
    <Show
      when={props.route.detail()}
      fallback={
        <Pane
          detail
          width={{ min: 360, default: 480 }}
          label={props.route.error() ? t.couldNotLoadDetails : t.loadingDetails}
          back={{ label: props.spaceName, href: props.route.baseHref(), onNavigate: () => props.route.close() }}
          head={
            <Bar start={<Text type="lead">{props.route.error() ? t.couldNotLoadDetails : t.loadingDetails}</Text>} end={closeButton()} />
          }
        >
          <Show when={props.route.error()} fallback={<Loading rows={6} lines={1} />}>
            {(error) => <Failed text={`${t.couldNotLoadDetails}: ${error().message}`} onRetry={props.route.retry} />}
          </Show>
        </Pane>
      }
    >
      {/* Not keyed: a refreshed snapshot of the same item keeps its editors, focus and drafts. */}
      {(detail) => <ItemDetail {...props} detail={detail()} close={closeButton} />}
    </Show>
  );
}

function ItemDetail(props: Props & { detail: SpaceItemDetail; close: () => JSXElement }) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const toast = useToast();
  const retryToast = createRetryToasts();
  const reactionPicker = createReactionPicker();
  const item = () => props.detail.item;
  const spaceId = props.space.id;
  const baseHref = () => props.route.baseHref();
  const recurring = () => props.detail.recurringContext;
  const reconcileAfterWrite = (): void =>
    void invalidateSpacesData().catch(() => retryToast(t.itemRefreshFailed, t.retry, reconcileAfterWrite));
  const failed = (error: Error) => toast(error.message, { status: "bad" });

  const isEvent = () => Boolean(item().startsAt && item().endsAt);
  const isCompleted = () => !!item().completedAt;
  const isGeneratedOccurrence = () => Boolean(recurring() && !recurring()!.isOverride);
  const canEditItem = createMemo(() => props.canWrite && !isGeneratedOccurrence());
  const activeBlockerCount = () => props.detail.blockedBy.filter((dependency) => !dependency.blocker.completedAt).length;
  const completionBlocked = () => !isCompleted() && activeBlockerCount() > 0;
  const scheduleStart = () => recurring()?.startsAt ?? item().startsAt;
  const scheduleEnd = () => recurring()?.endsAt ?? item().endsAt;
  const itemHref = (itemId: string) => {
    const url = new URL(baseHref(), "http://spaces.local");
    url.searchParams.set("item", itemId);
    return `${url.pathname}${url.search}`;
  };
  const seriesHref = () => (recurring() ? itemHref(recurring()!.seriesItemId) : baseHref());
  const open = (href: string) => requestSpacesRouteNavigation(href, { scroll: "preserve" });

  const patchItem = async (data: Record<string, unknown>) => {
    const res = await apiClient[":id"].items[":itemId"].$patch({ param: { id: spaceId, itemId: item().id }, json: data });
    if (!res.ok) throw new Error(await readResponseError(res, t.updateItemFailed));
    return (await res.json()) as SpaceItem;
  };
  const updateMutation = mutations.create<SpaceItem, Record<string, unknown>>({
    mutation: patchItem,
    onSuccess: () => reconcileAfterWrite(),
    onError: failed,
  });

  /**
   * One property edited in place: the value shows at once and falls back when the write fails. Edits made while a
   * save runs are not lost: the last one is saved next, so ticking two tags in a row keeps both.
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
      onSuccess: () => {
        saved = true;
        reconcileAfterWrite();
      },
      onError: (err, context) => {
        if (context) setValue(() => context.previous);
        failed(err);
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
    () => item().deadline,
    (deadline) => ({ deadline }),
  );
  const estimateEdit = createPropertyEdit(
    () => item().estimatedDurationMinutes,
    (estimatedDurationMinutes) => ({ estimatedDurationMinutes }),
  );
  const priorityEdit = createPropertyEdit<string | null>(
    () => item().priority,
    (priority) => ({ priority }),
  );
  const tagsEdit = createPropertyEdit(
    () => item().tags?.map((tag) => tag.id) ?? [],
    (tagIds) => ({ tagIds }),
  );
  const columnEdit = createPropertyEdit(
    () => item().columnId,
    (columnId) => ({ columnId }),
  );

  /** Removing the person who works on the task ends their claim: your own at once, someone else's after a question. */
  const updateAssignees = async (assigneeIds: string[]) => {
    const itemId = item().id;
    const before = item().assignees?.map((assignee) => assignee.id) ?? [];
    const delta = {
      addAssigneeIds: assigneeIds.filter((id) => !before.includes(id)),
      removeAssigneeIds: before.filter((id) => !assigneeIds.includes(id)),
    };
    const claim = await resolveAssigneeClaim(item().claim, props.currentUserId, item().assignees ?? [], assigneeIds, t);
    if (claim && item().id === itemId) await updateMutation.mutate({ ...delta, ...claim });
  };

  const blockerMutation = mutations.create<void, { add: boolean; id: string }>({
    mutation: async ({ add, id }, { abortSignal }) => {
      const target = { param: { id: spaceId, itemId: item().id }, json: { blockerItemId: id } };
      const response = add
        ? await apiClient[":id"].items[":itemId"].blockers.$post(target, { init: { signal: abortSignal } })
        : await apiClient[":id"].items[":itemId"].blockers.$delete(target, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readResponseError(response, add ? t.addBlockerFailed : t.removeBlockerFailed));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: failed,
  });
  const loadBlockers = async (search: string, context: { signal: AbortSignal; limit: number }) => {
    const response = await apiClient[":id"].items.filter.$post(
      {
        param: { id: spaceId },
        json: { type: "task", status: "all", search, sort: "updated", sortDesc: true, groupBy: "none", page: 1, pageSize: context.limit },
      },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(await readResponseError(response, t.searchTasksFailed));
    const excluded = new Set([item().id]);
    return {
      items: (await response.json()).items
        .filter((candidate) => !excluded.has(candidate.id))
        .map((candidate) => ({ value: candidate.id, label: candidate.title })),
    };
  };
  const loadPeople = async (search: string, context: { signal: AbortSignal; limit: number }) => {
    const response = await apiClient[":id"]["assignable-users"].$get(
      { param: { id: spaceId }, query: { search } },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(await readResponseError(response, t.loadAssigneesFailed));
    return { items: (await response.json()).slice(0, context.limit).map((user) => ({ value: user.id, label: user.displayName })) };
  };

  type CompleteIntent = { itemId: string; completed: boolean } & ClaimFields;
  const completeMutation = mutations.create<boolean, CompleteIntent, { intent: CompleteIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async (intent) => {
      await setItemCompleted({ spaceId, ...intent }, t.updateItemFailed);
      return intent.completed;
    },
    // A shortcut never focused the button, so a screen reader is told.
    onSuccess: (completed) => {
      announce(completed ? t.itemCompleted : t.itemReopened);
      reconcileAfterWrite();
    },
    onError: (err, context) => retryToast(err.message, t.retry, () => context && completeMutation.mutate(context.intent)),
  });
  /** Someone else's claim is taken over after one question; the answer belongs to the item it named. */
  const toggleCompleted = async () => {
    const itemId = item().id;
    const completed = !isCompleted();
    const claim = await resolveCompletionClaim(item().claim, props.currentUserId, completed, t);
    if (claim && item().id === itemId) await completeMutation.mutate({ itemId, completed, ...claim });
  };

  const claimMutation = mutations.create<string | null, "claim" | "release" | "take-over">({
    mutation: async (kind) => {
      const target = { spaceId, itemId: item().id };
      const claim = item().claim;
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
      const confirmed = await confirm({
        title: t.takeOverTitle,
        description: t.takeOverHelp({ name: claim.displayName }),
        confirm: t.takeOverClaim,
        cancel: t.cancel,
      });
      if (!confirmed) return null;
      await takeOverTask(target, claim, t);
      return t.claimTakenOver({ name: claim.displayName });
    },
    onSuccess: (message) => {
      if (!message) return;
      toast(message, { status: "ok" });
      reconcileAfterWrite();
    },
    onError: failed,
  });

  const duplicateMutation = mutations.create<SpaceItem, void>({
    mutation: async () => {
      const source = item();
      const res = await apiClient[":id"].items.$post({
        param: { id: spaceId },
        json: {
          requestKey: crypto.randomUUID(),
          columnId: source.columnId,
          title: `${source.title} (Copy)`,
          description: source.description ?? undefined,
          startsAt: source.startsAt ?? undefined,
          endsAt: source.endsAt ?? undefined,
          deadline: source.deadline ?? undefined,
          estimatedDurationMinutes: source.estimatedDurationMinutes ?? undefined,
          priority: source.priority ?? undefined,
          assigneeIds: source.assignees?.map((assignee) => assignee.id),
          tagIds: source.tags?.map((tag) => tag.id),
        },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.duplicateItemFailed));
      return res.json();
    },
    onSuccess: () => {
      toast(t.itemDuplicated, { status: "ok" });
      reconcileAfterWrite();
    },
    onError: failed,
  });

  type DeleteIntent = { itemId: string };
  const deleteMutation = mutations.create<void, DeleteIntent, { intent: DeleteIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ itemId }) => {
      const res = await apiClient[":id"].items[":itemId"].$delete({ param: { id: spaceId, itemId } });
      if (!res.ok) throw new Error(await readResponseError(res, t.deleteItemFailed));
    },
    onSuccess: (_, context) => {
      toast(t.itemDeleted, { status: "ok" });
      // A retry can succeed after the person opened another item; only the deleted item's detail closes.
      if (context?.intent.itemId === item().id) open(baseHref());
      else reconcileAfterWrite();
    },
    onError: (err, context) => retryToast(err.message, t.retry, () => context && deleteMutation.mutate(context.intent)),
  });
  const handleDelete = async () => {
    if (deleteMutation.loading()) return;
    const itemId = item().id;
    const confirmed = await confirm({ title: t.deleteItem, description: t.deleteItemQuestion({ title: item().title }), confirm: t.delete });
    if (confirmed) void deleteMutation.mutate({ itemId });
  };

  const transferMutation = mutations.create<WormholeTransferResult, { itemId: string; wormholeId: string; claim: ClaimFields }>({
    mutation: ({ itemId, wormholeId, claim }, context) =>
      transferThroughWormhole({ sourceSpaceId: spaceId, itemId, wormholeId, claim, signal: context.abortSignal, locale: locale() }),
    onSuccess: (result) => {
      showWormholeTransferToast(result, locale());
      open(baseHref());
    },
    onError: (error) => {
      if (error.name !== "AbortError") failed(error);
    },
  });
  /** A transfer ends the claim; someone else's is taken over after one question, as for completion. */
  const transferTo = async (wormholeId: string) => {
    const itemId = item().id;
    const claim = await resolveTransferClaim(item().claim, props.currentUserId, t);
    if (claim && item().id === itemId) await transferMutation.mutate({ itemId, wormholeId, claim });
  };

  // The dialog stays open until the save answers, so a failure shows in it with the input still there.
  let editing = false;
  const handleEdit = async () => {
    if (editing) return;
    editing = true;
    try {
      const saved = await openEditItemDialog({
        spaceId,
        item: item(),
        columns: props.space.columns,
        tags: props.space.tags,
        dateConfig: props.dateConfig,
        currentUserId: props.currentUserId,
        estimateSuggestion: Boolean(props.estimateSuggestions) && !isEvent(),
      });
      if (saved) reconcileAfterWrite();
    } finally {
      editing = false;
    }
  };

  /** Which assignees can still reach the Space; a template keeps only those. Unknown when the check fails. */
  const assigneesWithAccess = async (): Promise<Set<string> | undefined> => {
    try {
      const found = await Promise.all(
        (item().assignees ?? []).map(async (assignee) => {
          const response = await apiClient[":id"]["assignable-users"].$get({
            param: { id: spaceId },
            query: { search: assignee.displayName },
          });
          if (!response.ok) throw new Error(t.loadAssigneesFailed);
          return (await response.json()).some((user) => user.id === assignee.id) ? [assignee.id] : [];
        }),
      );
      return new Set(found.flat());
    } catch {
      return undefined;
    }
  };
  const saveAsTemplate = async () => {
    const { draft, suggestions } = templateFromItem(item(), {
      checklist: props.detail.checklist,
      assigneesWithAccess: await assigneesWithAccess(),
      dateConfig: props.dateConfig,
    });
    const saved = await openTemplateDialog({
      spaceId,
      kind: draft.kind,
      tags: props.space.tags,
      templates: [],
      dateConfig: props.dateConfig,
      locale: locale(),
      draft,
      suggestions,
    });
    if (saved) reconcileAfterWrite();
  };

  const busy = () =>
    updateMutation.loading() ||
    completeMutation.loading() ||
    duplicateMutation.loading() ||
    deleteMutation.loading() ||
    transferMutation.loading() ||
    blockerMutation.loading();

  createEffect(() => {
    if (!canEditItem() || busy()) return;
    const itemId = item().id;
    const title = item().title;
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
            if (item().id === itemId && canEditItem() && !busy() && !completionBlocked()) return toggleCompleted();
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
          if (item().id === itemId && canEditItem() && !busy()) return handleEdit();
        },
      }),
    );
    if (!item().assignees?.some((assignee) => assignee.kind === "user" && assignee.id === props.currentUserId))
      onCleanup(
        registerContextAwareCommand({
          scope: "selection",
          id: `spaces.${itemId}.assign`,
          title: t.assignFocusedItem,
          description: copy.assignDescription({ title }),
          icon: "ti ti-user-check",
          shortcut: "m",
          action: () => updateMutation.mutate({ addAssigneeIds: [props.currentUserId] }).then(() => undefined),
        }),
      );
  });

  const cloudId = useCloudIdCopy();
  const itemMenu = (): MenuEntry[] => [
    ...(canEditItem()
      ? [
          { label: t.editItem, icon: "pencil", meta: "E", onClick: () => void handleEdit() },
          { label: t.duplicateItem, icon: "copy", onClick: () => void duplicateMutation.mutate() },
          { label: t.saveAsTemplate, icon: "template", onClick: () => void saveAsTemplate() },
        ]
      : []),
    ...(canEditItem() && canTransferThroughWormhole(item())
      ? props.route.wormholes().flatMap((wormhole) =>
          wormhole.target
            ? [
                {
                  label: t.moveTo({ space: wormhole.target.spaceName, column: wormhole.target.columnName }),
                  icon: "arrow-bounce",
                  onClick: () => void transferTo(wormhole.id),
                },
              ]
            : [],
        )
      : []),
    ...(cloudId.available()
      ? [
          {
            label: cloudIdMessages.resolve([locale()]).t.copy,
            icon: "id",
            onClick: () => cloudId.copy({ type: "spaces.item", id: item().id }),
          },
        ]
      : []),
    ...(canEditItem() ? [{ label: t.deleteItem, icon: "trash", danger: true, onClick: () => void handleDelete() }] : []),
  ];

  const column = () => props.space.columns.find((entry) => entry.id === columnEdit.value());
  const priorityLabel = (priority: string | null) =>
    priority === "urgent" ? t.urgent : priority === "high" ? t.high : priority === "medium" ? t.medium : priority === "low" ? t.low : null;
  const due = (deadline: string) =>
    `${isDateOnlyDeadline(deadline) ? formatDeadline(deadline, props.dateConfig) : dates.formatDateTime(deadline, props.dateConfig)} · ${
      isDateOnlyDeadline(deadline) ? daysAway(deadline, props.dateConfig, locale()) : dates.formatTimeSpan(deadline, props.dateConfig)
    }`;
  const recurrenceSummary = () =>
    summarizeRecurrence(item().recurrence, {
      startsAt: scheduleStart(),
      allDay: recurring()?.allDay ?? item().allDay,
      dateConfig: props.dateConfig,
    });
  const tagNames = () =>
    tagsEdit
      .value()
      .map((id) => props.space.tags.find((tag) => tag.id === id)?.name)
      .filter(Boolean)
      .join(", ");
  const [deadlineDay, setDeadlineDay] = createSignal("");
  const [deadlineTime, setDeadlineTime] = createSignal("");
  const [estimateText, setEstimateText] = createSignal("");

  /** A property's value, and for editors the control that changes it in place. */
  const editable = (text: string, control: () => JSXElement) => (canEditItem() ? control() : text);
  const facts = (): Fact[] => {
    const schedule: Fact[] = isEvent()
      ? [
          { label: t.start, value: dates.formatDateTime(scheduleStart()!, props.dateConfig) },
          { label: t.end, value: dates.formatDateTime(scheduleEnd()!, props.dateConfig) },
          { label: t.duration, value: dates.formatDuration(scheduleStart()!, scheduleEnd()!, props.dateConfig) },
          ...(recurrenceSummary() ? [{ label: t.repeatTerm, value: recurrenceSummary()! }] : []),
          ...(item().location ? [{ label: t.location, value: item().location! }] : []),
          ...(item().url ? [{ label: t.url, value: <Text href={item().url!}>{item().url}</Text> }] : []),
        ]
      : [
          ...(canEditItem() || deadlineEdit.value()
            ? [
                {
                  label: t.due,
                  value: editable(deadlineEdit.value() ? due(deadlineEdit.value()!) : t.noDeadline, () => (
                    // k2b-ui gap: no date-time picker in a fact; the day and an optional time are edited in a panel.
                    <Popover
                      variant="text"
                      title={t.due}
                      content={
                        <>
                          <Field label={t.date} name="due-day">
                            <DateInput
                              value={deadlineDay() || (deadlineEdit.value() ?? "").slice(0, 10)}
                              onInput={(value) => setDeadlineDay(value)}
                            />
                          </Field>
                          <Field label={t.time} name="due-time" optional={t.optional}>
                            <Input
                              value={
                                deadlineTime() ||
                                (deadlineEdit.value() && !isDateOnlyDeadline(deadlineEdit.value()!)
                                  ? dates.formatTime(deadlineEdit.value()!, props.dateConfig)
                                  : "")
                              }
                              placeholder="09:00"
                              onInput={setDeadlineTime}
                            />
                          </Field>
                          <Bar
                            end={
                              <>
                                <Button onClick={() => void deadlineEdit.update(null)}>{t.clear}</Button>
                                <Button
                                  onClick={() => {
                                    const day = deadlineDay() || (deadlineEdit.value() ?? "").slice(0, 10);
                                    if (!day) return;
                                    const time = deadlineTime().trim();
                                    if (time && !/^\d{1,2}:\d{2}$/.test(time)) return toast(t.invalidTime, { status: "bad" });
                                    void deadlineEdit.update(
                                      time
                                        ? dates.zonedDateTimeToInstant(`${day}T${time}`, props.dateConfig?.timeZone ?? "UTC", {
                                            disambiguation: "earlier",
                                          })
                                        : day,
                                    );
                                  }}
                                >
                                  {t.save}
                                </Button>
                              </>
                            }
                          />
                        </>
                      }
                    >
                      {deadlineEdit.value() ? due(deadlineEdit.value()!) : t.noDeadline}
                    </Popover>
                  )),
                },
              ]
            : []),
        ];
    const people = itemPeople(item()).join(", ");
    return [
      ...(canEditItem() || people
        ? [
            {
              label: t.assignedPeople,
              value: editable(people || "—", () => (
                <Popover
                  variant="text"
                  title={t.assignedPeople}
                  content={
                    <Lookup
                      label={t.searchPeople}
                      value={(item().assignees ?? []).map((assignee) => assignee.id)}
                      known={(item().assignees ?? []).map((assignee) => ({ value: assignee.id, label: assignee.displayName }))}
                      load={loadPeople}
                      onChange={(ids) => void updateAssignees(ids)}
                    />
                  }
                >
                  {people || t.nobodyAssigned}
                </Popover>
              )),
            },
          ]
        : []),
      ...(item().claim && !isEvent() ? [{ label: t.workingOnIt, value: item().claim!.displayName }] : []),
      ...schedule,
      {
        label: t.status,
        value: editable(column()?.name ?? "—", () => (
          <Menu
            variant="text"
            items={[
              {
                title: t.status,
                choice: columnEdit.value(),
                onChoose: (value) => void columnEdit.update(value),
                items: props.space.columns.map((entry) => ({ label: entry.name, value: entry.id })),
              },
            ]}
          >
            {column()?.name ?? "—"}
          </Menu>
        )),
      },
      ...(canEditItem() || tagNames()
        ? [
            {
              label: t.tags,
              value: editable(tagNames(), () => (
                <Menu
                  variant="text"
                  disabled={props.space.tags.length === 0}
                  items={props.space.tags.map((tag) => ({
                    label: tag.name,
                    checked: tagsEdit.value().includes(tag.id),
                    onClick: () =>
                      void tagsEdit.update(
                        tagsEdit.value().includes(tag.id) ? tagsEdit.value().filter((id) => id !== tag.id) : [...tagsEdit.value(), tag.id],
                      ),
                  }))}
                >
                  {tagNames() || t.addTagShort}
                </Menu>
              )),
            },
          ]
        : []),
      ...(canEditItem() || priorityEdit.value()
        ? [
            {
              label: t.priority,
              value: editable(priorityLabel(priorityEdit.value()) ?? "", () => (
                <Menu
                  variant="text"
                  items={[
                    {
                      title: t.priority,
                      choice: priorityEdit.value() ?? "none",
                      onChoose: (value) => void priorityEdit.update(value === "none" ? null : value),
                      items: [
                        { label: t.urgent, value: "urgent" },
                        { label: t.high, value: "high" },
                        { label: t.medium, value: "medium" },
                        { label: t.low, value: "low" },
                        { label: t.noPriority, value: "none" },
                      ],
                    },
                  ]}
                >
                  {priorityLabel(priorityEdit.value()) ?? t.noPriority}
                </Menu>
              )),
            },
          ]
        : []),
      ...(!isEvent() && (canEditItem() || estimateEdit.value())
        ? [
            {
              label: t.estimate,
              value: editable(estimateEdit.value() ? formatEstimate(estimateEdit.value()!) : "", () => (
                <Popover
                  variant="text"
                  title={t.estimate}
                  content={
                    <>
                      <Field label={t.estimate} name="estimate" optional="min">
                        <Input
                          type="number"
                          min={1}
                          value={estimateText() || String(estimateEdit.value() ?? "")}
                          onInput={setEstimateText}
                        />
                      </Field>
                      <Bar
                        end={
                          <Button
                            onClick={() => {
                              const minutes = Number.parseInt(estimateText(), 10);
                              void estimateEdit.update(Number.isFinite(minutes) && minutes > 0 ? minutes : null);
                            }}
                          >
                            {t.save}
                          </Button>
                        }
                      />
                    </>
                  }
                >
                  {estimateEdit.value() ? formatEstimate(estimateEdit.value()!) : t.noEstimate}
                </Popover>
              )),
            },
          ]
        : []),
    ];
  };

  /** Open blockers first; more than three wait behind one press. */
  const [blockersOpen, setBlockersOpen] = createSignal(false);
  const orderedBlockers = () =>
    [...props.detail.blockedBy].sort(
      (left, right) => Number(Boolean(left.blocker.completedAt)) - Number(Boolean(right.blocker.completedAt)),
    );
  const visibleBlockers = () => (blockersOpen() ? orderedBlockers() : orderedBlockers().slice(0, 3));
  const references = () => {
    const all = props.detail.references;
    return [
      ...all.filter((reference) => reference.ref.type === "spaces.item"),
      ...all.filter((reference) => reference.ref.type !== "spaces.item"),
    ];
  };
  const hasMedia = () =>
    props.detail.attachments.some((attachment) => attachment.kind === "image" || isPlayableVideoType(attachment.mimeType));
  const comments = useItemComments({
    spaceId,
    itemId: () => item().id,
    target: () => props.detail.commentTarget,
    initialPage: props.detail.comments,
    retryToast,
  });
  const stateChip = () =>
    isCompleted() ? (
      <Chip status="ok">{t.completed}</Chip>
    ) : completionBlocked() ? (
      <Chip status="warn" icon="lock">
        {t.blockedByCount({ count: activeBlockerCount() })}
      </Chip>
    ) : (
      <Chip>{t.active}</Chip>
    );
  const claimAction = () => {
    const claim = item().claim;
    if (isEvent() || isCompleted() || !canEditItem()) return undefined;
    if (!claim)
      return (
        <Button busy={claimMutation.loading()} disabled={completionBlocked()} onClick={() => void claimMutation.mutate("claim")}>
          {t.imOnIt}
        </Button>
      );
    return claim.actor.kind === "user" && claim.actor.id === props.currentUserId ? (
      <Button busy={claimMutation.loading()} onClick={() => void claimMutation.mutate("release")}>
        {t.releaseClaim}
      </Button>
    ) : (
      <Button busy={claimMutation.loading()} onClick={() => void claimMutation.mutate("take-over")}>
        {t.takeOverClaim}
      </Button>
    );
  };

  return (
    <Pane
      detail
      width={{ min: 360, default: 480 }}
      label={item().title}
      scrollKey={props.route.scrollKey()}
      back={{ label: props.spaceName, href: baseHref(), onNavigate: () => props.route.close() }}
      head={
        <Bar
          start={<Text type="lead">{item().title}</Text>}
          end={
            <>
              <Show when={canEditItem()}>
                <Button
                  icon={isCompleted() ? "arrow-back-up" : completionBlocked() ? "lock" : "circle-check"}
                  busy={completeMutation.loading()}
                  disabled={busy() || completionBlocked()}
                  keep
                  onClick={() => void toggleCompleted()}
                >
                  {isCompleted() ? t.reopen : t.markComplete}
                </Button>
              </Show>
              <Menu label={t.moreItemActions} items={itemMenu()} />
              {props.close()}
            </>
          }
        />
      }
      status={
        <Bar
          start={
            <Inline>
              <Text type="meta">{isEvent() ? t.event : t.task}</Text>
              {stateChip()}
              <Show when={recurring()}>
                <Chip icon="repeat">{t.thisOccurrence}</Chip>
              </Show>
              <Show when={!props.canWrite}>
                <Chip icon="lock">{t.readOnly}</Chip>
              </Show>
            </Inline>
          }
          end={
            <>
              {claimAction()}
              <Show when={recurring()}>
                <Button variant="text" icon="repeat" href={seriesHref()} onNavigate={() => open(seriesHref())}>
                  {t.viewSeries}
                </Button>
              </Show>
            </>
          }
        />
      }
    >
      <Section
        icon="list-details"
        title={t.properties}
        actions={canEditItem() ? [{ label: t.editItem, icon: "pencil", onClick: () => void handleEdit() }] : undefined}
      >
        <Facts items={facts()} />
      </Section>

      <Show when={!isEvent() && (canEditItem() || props.detail.blockedBy.length > 0 || props.detail.blocks.length > 0)}>
        <Section icon="lock" title={t.blockedBy} count={props.detail.blockedBy.length}>
          <For each={visibleBlockers()}>
            {(dependency) => (
              <Row
                icon={dependency.blocker.completedAt ? "circle-check" : "lock"}
                lines={[dependency.blocker.title, dependency.blocker.completedAt ? t.completed : t.active]}
                href={itemHref(dependency.blocker.id)}
                onNavigate={() => open(itemHref(dependency.blocker.id))}
                end={
                  canEditItem() ? (
                    <Button
                      variant="ghost"
                      icon="x"
                      label={t.removeBlockerNamed({ title: dependency.blocker.title })}
                      disabled={blockerMutation.loading()}
                      onClick={() => void blockerMutation.mutate({ add: false, id: dependency.blocker.id })}
                    />
                  ) : undefined
                }
              />
            )}
          </For>
          <Show when={orderedBlockers().length > 3}>
            <Bar
              end={
                <Button variant="text" onClick={() => setBlockersOpen(!blockersOpen())}>
                  {blockersOpen() ? t.fewerDependencies : t.moreDependencies({ count: orderedBlockers().length - 3 })}
                </Button>
              }
            />
          </Show>
          <Show when={canEditItem()}>
            <Bar
              end={
                <Popover
                  icon="plus"
                  title={t.addTaskBlocker}
                  content={
                    <Lookup
                      label={t.blockerSearchPlaceholder}
                      value={props.detail.blockedBy.map((dependency) => dependency.blocker.id)}
                      known={props.detail.blockedBy.map((dependency) => ({
                        value: dependency.blocker.id,
                        label: dependency.blocker.title,
                      }))}
                      load={loadBlockers}
                      onChange={(ids) => {
                        const before = props.detail.blockedBy.map((dependency) => dependency.blocker.id);
                        const added = ids.find((id) => !before.includes(id));
                        const removed = before.find((id) => !ids.includes(id));
                        if (added) void blockerMutation.mutate({ add: true, id: added });
                        else if (removed) void blockerMutation.mutate({ add: false, id: removed });
                      }}
                    />
                  }
                >
                  {t.addBlockerShort}
                </Popover>
              }
            />
          </Show>
          <For each={props.detail.blocks}>
            {(dependency) => (
              <Row
                icon="arrow-right"
                lines={[dependency.dependent.title, t.blocks]}
                href={itemHref(dependency.dependent.id)}
                onNavigate={() => open(itemHref(dependency.dependent.id))}
              />
            )}
          </For>
        </Section>
      </Show>

      <Show when={item().description}>
        {(description) => (
          <Section
            icon="align-left"
            title={t.description}
            actions={canEditItem() ? [{ label: t.editDescription, icon: "pencil", onClick: () => void handleEdit() }] : undefined}
          >
            <Prose markdown={description()} />
          </Section>
        )}
      </Show>

      {/* The discussion starts with the reactions; a generated occurrence of a series has none of its own. */}
      <Show when={!isGeneratedOccurrence() && (canEditItem() || (item().reactions?.length ?? 0) > 0)}>
        <Band>
          {/* The reaction chips and their emoji picker draw themselves, as on the cards of the board. */}
          <Canvas label={t.reactions}>
            <ItemReactions
              spaceId={spaceId}
              itemId={item().id}
              reactions={item().reactions}
              canReact={canEditItem()}
              picker={reactionPicker}
              retryToast={retryToast}
              density="default"
              add="always"
            />
            {reactionPicker.popover()}
          </Canvas>
        </Band>
      </Show>

      <Show when={!isEvent() && (canEditItem() || props.detail.checklist.length > 0)}>
        <TaskChecklistSection
          spaceId={spaceId}
          itemId={item().id}
          entries={props.detail.checklist}
          canWrite={canEditItem()}
          onChanged={reconcileAfterWrite}
        />
      </Show>

      <Show when={props.canWrite || comments.page().total > 0}>
        <CommentsSection
          spaceId={spaceId}
          itemId={props.detail.commentTarget.itemId}
          recurrenceId={props.detail.commentTarget.recurrenceId}
          comments={comments.page().items}
          total={comments.page().total}
          loading={comments.query.loading()}
          hasMore={comments.page().hasNext}
          loadingMore={comments.query.loadingMore()}
          loadError={comments.query.error()?.message}
          onLoadMore={() => comments.query.loadMore()}
          onRetry={() => comments.query.refresh()}
          currentUserId={props.currentUserId}
          onUpdate={comments.refresh}
          dateConfig={props.dateConfig}
          canWrite={props.canWrite}
        />
      </Show>

      <Show when={isEvent() && canEditItem() && props.mailIntegrationAvailable}>
        <EventInvitations spaceId={spaceId} itemId={item().id} title={item().title} />
      </Show>

      <Show when={!isEvent() && props.detail.work?.progress}>
        {(note) => (
          <Section icon="progress" title={t.workProgress}>
            <Prose markdown={note().content} />
          </Section>
        )}
      </Show>
      <Show when={!isEvent() && props.detail.work?.result}>
        {(result) => (
          <Section icon="flag-check" title={t.workResult}>
            <Prose markdown={result().content} />
            <Show when={result().commit}>
              {(commit) => <Facts items={[{ label: t.commit, value: commit(), mono: true, copy: commit() }]} />}
            </Show>
          </Section>
        )}
      </Show>

      <Show when={canEditItem() || references().length > 0 || props.detail.links.length > 0}>
        <ItemLinksSection
          spaceId={spaceId}
          itemId={item().id}
          references={references()}
          links={props.detail.links}
          canEdit={canEditItem()}
          onChanged={reconcileAfterWrite}
        />
      </Show>

      <Show when={!isEvent() && (canEditItem() || hasMedia())}>
        <TaskAttachmentsSection
          spaceId={spaceId}
          itemId={item().id}
          attachments={props.detail.attachments}
          canWrite={canEditItem()}
          onChanged={reconcileAfterWrite}
        />
      </Show>

      <Show when={props.route.detail()?.item.id === item().id}>
        <ItemHistorySection spaceId={spaceId} itemId={props.detail.commentTarget.itemId} dateConfig={props.dateConfig} />
      </Show>

      <Section icon="info-circle" title={isEvent() ? t.moreAboutEvent : t.moreAboutTask}>
        <Facts
          items={[
            { label: t.created, value: dates.formatDateTime(item().createdAt, props.dateConfig) },
            { label: t.updated, value: dates.formatDateTime(item().updatedAt, props.dateConfig) },
            { label: "ID", value: item().id, mono: true, copy: item().id },
          ]}
        />
      </Section>
      <Show when={props.route.access()}>
        {(access) => (
          <Section icon="users" title={t.accessTitle} summary={t.accessWholeSpace}>
            <Show when={access().state !== "error"} fallback={<Failed text={t.loadAccessFailed} onRetry={access().retry} />}>
              <Show when={access().state === "ready"} fallback={<Loading rows={3} lines={1} />}>
                <For each={accessMemberEntries(access().members, { currentUserId: props.currentUserId, locale: locale() })}>
                  {(entry) =>
                    entry.kind === "person" ? (
                      <Row avatar={{ name: entry.name, image: entry.src ?? undefined }} lines={[entry.name, entry.role]} />
                    ) : (
                      <Row
                        icon={entry.kind === "group" ? "users" : entry.kind === "service" ? "robot" : "world"}
                        lines={[entry.name, entry.role]}
                      />
                    )
                  }
                </For>
              </Show>
            </Show>
          </Section>
        )}
      </Show>
    </Pane>
  );
}

type JSXElement = import("solid-js").JSX.Element;
