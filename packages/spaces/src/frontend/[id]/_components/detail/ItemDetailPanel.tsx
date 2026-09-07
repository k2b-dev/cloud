import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  Combobox,
  DescriptionList,
  DetailPanel,
  Dropdown,
  type DropdownItem,
  IconButton,
  MarkdownView,
  MultiSelectInput,
  prompts,
  Select,
  Tag,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { openCloudResourcePicker } from "@valentinkolb/cloud/browser/resource-picker";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type {
  SpaceColumn,
  SpaceItem,
  SpaceItemAssignee,
  SpaceItemResourceReferenceInput,
  SpaceTag,
  SpaceTaskDependency,
  SpaceTaskDependent,
  SpaceWormhole,
  WormholeTransferResult,
} from "@/contracts";
import { summarizeRecurrence } from "@/presentation/recurrence";
import { shouldHandleDetailClick } from "../../../lib/detail";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import { openEditItemDialog, saveItemFormData } from "../shared/editItem";
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
import EventInvitations from "./EventInvitations";
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

/** Assignees section with add/remove functionality */
function AssigneesSection(props: {
  spaceId: string;
  assignees: SpaceItemAssignee[];
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
export default function ItemDetailPanel(props: Props) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const priorityOptions = [
    { value: "urgent", label: t.urgent, icon: "ti ti-alert-circle", color: "#ef4444" },
    { value: "high", label: t.high, icon: "ti ti-arrow-up", color: "#f97316" },
    { value: "medium", label: t.medium, icon: "ti ti-minus", color: "#eab308" },
    { value: "low", label: t.low, icon: "ti ti-arrow-down", color: "#3b82f6" },
  ] as const;
  const reconcileAfterWrite = () => void invalidateSpacesData().catch(() => prompts.error(t.itemRefreshFailed));
  const [selectedPriorityValue, setSelectedPriorityValue] = createSignal<string | null>(props.item.priority);
  const [selectedTagIds, setSelectedTagIds] = createSignal(props.item.tags?.map((tag) => tag.id) ?? []);

  const unlinkReference = mutations.create<void, { type: string; id: string }>({
    mutation: async (ref, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].references.$delete(
        { param: { id: props.spaceId, itemId: props.item.id }, json: { ref } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.unlinkResourceFailed));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: (error) => prompts.error(error.message),
  });

  const linkReference = mutations.create<void, SpaceItemResourceReferenceInput>({
    mutation: async (reference, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].references.$post(
        { param: { id: props.spaceId, itemId: props.item.id }, json: reference },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.linkResourceFailed));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: (error) => prompts.error(error.message),
  });

  const addBlocker = mutations.create<void, string>({
    mutation: async (blockerItemId, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].blockers.$post(
        { param: { id: props.spaceId, itemId: props.item.id }, json: { blockerItemId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.addBlockerFailed));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: (error) => prompts.error(error.message),
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
    onError: (error) => prompts.error(error.message),
  });

  const linkCloudResource = async () => {
    const selected = await openCloudResourcePicker({
      title: t.linkCloudResource,
      excludeRefs: [{ type: "spaces.item", id: props.item.id }, ...(props.references?.map((reference) => reference.ref) ?? [])],
      requireReader: true,
    });
    if (!selected) return;
    await linkReference.mutate({ ref: selected.ref, label: selected.title });
  };

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

  createEffect(() => {
    setSelectedPriorityValue(props.item.priority);
    setSelectedTagIds(props.item.tags?.map((tag) => tag.id) ?? []);
  });
  const isGeneratedOccurrence = () => Boolean(props.recurringContext && !props.recurringContext.isOverride);
  const canEditItem = () => props.canWrite && !isGeneratedOccurrence();
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

  const handleItemUpdated = (item: SpaceItem | null) => {
    if (!item) return;
    toast.success(t.itemUpdated);
    reconcileAfterWrite();
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
    onError: (err) => prompts.error(err.message),
  });

  type PriorityIntent = { next: string | null; previous: string | null };
  const priorityMutation = mutations.create<SpaceItem, PriorityIntent, { previous: string | null }>({
    onBefore: (intent) => ({ previous: intent.previous }),
    mutation: (intent) => patchItem({ priority: intent.next }),
    onSuccess: handleItemUpdated,
    onError: (err, context) => {
      if (context) setSelectedPriorityValue(context.previous);
      prompts.error(err.message);
    },
    onAbort: (context) => {
      if (context) setSelectedPriorityValue(context.previous);
    },
  });
  let prioritySubmitting = false;

  const updatePriority = async (priority: string | null) => {
    if (prioritySubmitting || priorityMutation.loading()) return;
    prioritySubmitting = true;
    const previous = selectedPriorityValue();
    setSelectedPriorityValue(priority);
    try {
      await priorityMutation.mutate({ next: priority, previous });
    } finally {
      prioritySubmitting = false;
    }
  };

  type TagsIntent = { next: string[]; previous: string[] };
  const tagsMutation = mutations.create<SpaceItem, TagsIntent, { previous: string[] }>({
    onBefore: (intent) => ({ previous: intent.previous }),
    mutation: (intent) => patchItem({ tagIds: intent.next }),
    onSuccess: handleItemUpdated,
    onError: (err, context) => {
      if (context) setSelectedTagIds(context.previous);
      prompts.error(err.message);
    },
    onAbort: (context) => {
      if (context) setSelectedTagIds(context.previous);
    },
  });
  let tagsSubmitting = false;

  const updateTags = async (tagIds: string[]) => {
    if (tagsSubmitting || tagsMutation.loading()) return;
    tagsSubmitting = true;
    const previous = selectedTagIds();
    setSelectedTagIds(tagIds);
    try {
      await tagsMutation.mutate({ next: tagIds, previous });
    } finally {
      tagsSubmitting = false;
    }
  };

  const completeMutation = mutations.create<boolean, boolean>({
    mutation: async (completed: boolean) => {
      const res = await apiClient[":id"].items[":itemId"].completed.$post({
        param: { id: props.spaceId, itemId: props.item.id },
        json: { completed },
      });
      if (!res.ok) {
        throw new Error(await readResponseError(res, t.updateItemFailed));
      }
      await res.json();
      return completed;
    },
    onSuccess: (completed) => {
      toast.success(completed ? t.itemCompleted : t.itemReopened);
      reconcileAfterWrite();
    },
    onError: (err) => prompts.error(err.message),
  });

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
    onError: (err) => prompts.error(err.message),
  });

  const deleteMutation = mutations.create<void, { itemId: string }>({
    mutation: async ({ itemId }) => {
      const res = await apiClient[":id"].items[":itemId"].$delete({
        param: { id: props.spaceId, itemId },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.deleteItemFailed));
    },
    onSuccess: () => {
      toast.success(t.itemDeleted);
      requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
    },
    onError: (err) => prompts.error(err.message),
  });

  const transferMutation = mutations.create<WormholeTransferResult, string>({
    mutation: (wormholeId, context) =>
      transferThroughWormhole({
        sourceSpaceId: props.spaceId,
        itemId: props.item.id,
        wormholeId,
        signal: context.abortSignal,
        locale: locale(),
      }),
    onSuccess: (result) => {
      showWormholeTransferToast(result, locale());
      requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
    },
    onError: (error) => {
      if (error.name !== "AbortError") prompts.error(error.message);
    },
  });

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
      if (confirmed) void deleteMutation.mutate({ itemId: props.item.id });
    } finally {
      deletePromptPending = false;
    }
  };

  type EditIntent = Parameters<typeof saveItemFormData>[0];
  const editItemMutation = mutations.create<void, EditIntent>({
    mutation: saveItemFormData,
    onSuccess: () => {
      toast.success(t.itemUpdated);
      reconcileAfterWrite();
    },
    onError: (err) => prompts.error(err.message),
  });
  let editPromptPending = false;
  const handleEdit = async () => {
    if (editPromptPending || editItemMutation.loading()) return;
    editPromptPending = true;
    try {
      const data = await openEditItemDialog({
        spaceId: props.spaceId,
        item: props.item,
        columns: props.columns,
        tags: props.tags,
        dateConfig: props.dateConfig,
      });
      if (data) void editItemMutation.mutate({ spaceId: props.spaceId, itemId: props.item.id, data, locale: props.dateConfig?.locale });
    } finally {
      editPromptPending = false;
    }
  };

  const isLoading = () =>
    updateMutation.loading() ||
    priorityMutation.loading() ||
    tagsMutation.loading() ||
    completeMutation.loading() ||
    duplicateMutation.loading() ||
    deleteMutation.loading() ||
    transferMutation.loading() ||
    editItemMutation.loading() ||
    addBlocker.loading() ||
    removeBlocker.loading();

  const isEvent = () => Boolean(props.item.startsAt && props.item.endsAt);
  const isCompleted = () => !!props.item.completedAt;
  const completionBlocked = () => !isCompleted() && activeBlockerCount() > 0;
  const recurrenceSummary = () =>
    summarizeRecurrence(props.item.recurrence, {
      startsAt: scheduleStart(),
      allDay: props.recurringContext?.allDay ?? props.item.allDay,
      dateConfig: props.dateConfig,
    });
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
                  action: () => transferMutation.mutate(wormhole.id),
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

  const scheduleTitle = () => (isEvent() ? t.eventTime : t.deadline);
  const selectedPriority = () => priorityOptions.find((option) => option.value === selectedPriorityValue());

  const canShowClassification = () => canEditItem() || Boolean(props.item.priority) || (props.item.tags?.length ?? 0) > 0;
  const canShowAssignees = () => canEditItem() || (props.item.assignees?.length ?? 0) > 0;
  const canShowInvitations = () => isEvent() && canEditItem() && props.mailIntegrationAvailable;
  const canShowEventContext = () => isEvent() && (Boolean(props.item.location || props.item.url) || canShowInvitations());
  const activeBlockerCount = () => (props.blockedBy ?? []).filter((dependency) => !dependency.blocker.completedAt).length;
  const relatedTasks = () => (props.references ?? []).filter((reference) => reference.ref.type === "spaces.item");
  const linkedResources = () => (props.references ?? []).filter((reference) => reference.ref.type !== "spaces.item");
  const itemHref = (itemId: string) => {
    const url = new URL(props.baseUrl, "http://spaces.local");
    url.searchParams.set("item", itemId);
    return `${url.pathname}${url.search}`;
  };
  const linkedResourcesSection = () => (
    <DetailPanel.Section title={t.linkedResources} icon="ti ti-link" tone="neutral">
      <div class="flex flex-col gap-1">
        <For each={linkedResources()}>
          {(reference) => {
            const href = () => reference.resource?.links?.find((link) => link.rel === "open")?.href;
            const icon = () => reference.resource?.icon ?? (reference.ref.type === "mail.conversation" ? "ti ti-mail" : "ti ti-link");
            const menu = () =>
              canEditItem()
                ? {
                    menuLabel: `More actions for ${reference.label}`,
                    menuItems: [
                      {
                        label: t.unlink,
                        icon: "ti ti-unlink",
                        disabled: unlinkReference.loading(),
                        action: () => unlinkReference.mutate(reference.ref),
                      },
                    ],
                  }
                : {};
            return (
              <Show
                when={href()}
                fallback={
                  <DetailPanel.Action
                    type="button"
                    disabled
                    leading={<i class={icon()} aria-hidden="true" />}
                    title={reference.label}
                    description={t.resourceUnavailable}
                    {...menu()}
                  />
                }
              >
                {(openHref) => (
                  <DetailPanel.Action
                    href={openHref()}
                    leading={<i class={icon()} aria-hidden="true" />}
                    title={reference.label}
                    description={reference.resource?.title !== reference.label ? reference.resource?.title : undefined}
                    trailing={!canEditItem() ? <i class="ti ti-chevron-right" aria-hidden="true" /> : undefined}
                    {...menu()}
                  />
                )}
              </Show>
            );
          }}
        </For>
        <Show when={canEditItem()}>
          <DetailPanel.Action
            type="button"
            onClick={() => void linkCloudResource()}
            disabled={linkReference.loading()}
            leading={
              <i
                class={
                  linkReference.loading()
                    ? "ti ti-loader-2 animate-spin text-[var(--k2b-action)]"
                    : "ti ti-link-plus text-[var(--k2b-action)]"
                }
                aria-hidden="true"
              />
            }
            title={t.linkCloudResource}
          />
        </Show>
      </div>
    </DetailPanel.Section>
  );

  return (
    <div class="h-full min-h-0" style="view-transition-name: detail-panel">
      <DetailPanel>
        <DetailPanel.Header
          class="[view-transition-name:space-item-detail-header]"
          icon={`ti ${isEvent() ? "ti-calendar-event" : "ti-checkbox"}`}
          title={props.item.title}
          subtitle={isEvent() ? t.event : t.task}
          meta={
            <>
              <span
                class="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium leading-4"
                style={{
                  color: isCompleted()
                    ? "var(--k2b-success-text)"
                    : completionBlocked()
                      ? "var(--k2b-warning-text)"
                      : "var(--k2b-text-muted)",
                }}
              >
                <i class={`ti ${isCompleted() ? "ti-check" : completionBlocked() ? "ti-lock" : "ti-circle"}`} aria-hidden="true" />
                {isCompleted() ? t.completed : completionBlocked() ? t.blockedByCount({ count: activeBlockerCount() }) : t.active}
              </span>
              <Show when={!props.canWrite}>
                <span class="inline-flex items-center gap-1 text-dimmed">
                  <i class="ti ti-lock" aria-hidden="true" /> Read only
                </span>
              </Show>
              <Show when={props.recurringContext}>
                <span class="inline-flex items-center gap-1 text-secondary">
                  <i class="ti ti-repeat" aria-hidden="true" /> This occurrence
                </span>
              </Show>
            </>
          }
          actions={
            <>
              <Show when={canEditItem()}>
                <Dropdown.Root position="bottom-left" items={itemActions()}>
                  <Dropdown.Trigger iconOnly label={t.moreItemActions} tooltip={t.moreItemActions}>
                    <i class="ti ti-dots" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <Tooltip.Anchor content={t.closeDetails}>
                <ButtonLink
                  href={props.baseUrl}
                  onClick={(event) => {
                    if (!shouldHandleDetailClick(event, event.currentTarget)) return;
                    event.preventDefault();
                    requestSpacesRouteNavigation(props.baseUrl, { scroll: "preserve" });
                  }}
                  variant="ghost"
                  size="sm"
                  class="h-8 w-8 px-0"
                  aria-label={t.closeItemDetails}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </ButtonLink>
              </Tooltip.Anchor>
            </>
          }
          primaryActions={
            props.canWrite || props.recurringContext ? (
              <>
                <Show when={canEditItem()}>
                  <Button
                    type="button"
                    onClick={() => completeMutation.mutate(!isCompleted())}
                    disabled={isLoading() || completionBlocked()}
                    title={completionBlocked() ? t.completeBlockersFirst : undefined}
                    variant="secondary"
                    size="sm"
                    style={completionBlocked() ? { color: "var(--k2b-warning-text)", background: "var(--k2b-warning-surface)" } : undefined}
                  >
                    <Show when={isCompleted() || completeMutation.loading()}>
                      <i class={`ti ${completeMutation.loading() ? "ti-loader-2 animate-spin" : "ti-check"}`} aria-hidden="true" />
                    </Show>
                    <Show when={!isCompleted() && !completeMutation.loading()}>
                      <i
                        class={`ti ${completionBlocked() ? "ti-lock" : "ti-circle-check"}`}
                        style={{ color: completionBlocked() ? "inherit" : "var(--k2b-success-text)" }}
                        aria-hidden="true"
                      />
                    </Show>
                    {isCompleted() ? t.reopen : completionBlocked() ? t.blockedByCount({ count: activeBlockerCount() }) : t.markComplete}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void handleEdit()} disabled={isLoading()}>
                    <i class="ti ti-pencil" aria-hidden="true" /> Edit
                  </Button>
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
                    <i class="ti ti-repeat" aria-hidden="true" /> View series
                  </ButtonLink>
                </Show>
              </>
            ) : undefined
          }
        />

        <DetailPanel.Body scrollPreserveKey={props.scrollPreserveKey}>
          <Show when={isEvent() || props.item.deadline || props.item.estimatedDurationMinutes}>
            <DetailPanel.Summary
              title={scheduleTitle()}
              actions={
                canEditItem() ? (
                  <IconActionButton
                    icon="ti ti-pencil"
                    title={isEvent() ? t.editEventTime : t.editDeadline}
                    onClick={() => void handleEdit()}
                    disabled={isLoading()}
                  />
                ) : undefined
              }
            >
              <Show
                when={isEvent()}
                fallback={
                  <DescriptionList
                    layout="rows"
                    size="sm"
                    items={[
                      ...(props.item.deadline
                        ? [
                            { term: t.deadline, description: dates.formatDateTime(props.item.deadline, props.dateConfig) },
                            { term: t.due, description: dates.formatTimeSpan(props.item.deadline, props.dateConfig) },
                          ]
                        : []),
                      ...(props.item.estimatedDurationMinutes
                        ? [{ term: t.estimate, description: formatEstimatedDuration(props.item.estimatedDurationMinutes) }]
                        : []),
                    ]}
                  />
                }
              >
                <DescriptionList
                  layout="rows"
                  size="sm"
                  items={[
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
                  ]}
                />
              </Show>
            </DetailPanel.Summary>
          </Show>

          <Show when={canShowEventContext()}>
            <DetailPanel.Group label={t.eventContext}>
              <Show when={props.item.location || props.item.url}>
                <DetailPanel.Section
                  title={t.eventDetails}
                  icon="ti ti-map-pin"
                  tone="accent"
                  actions={
                    canEditItem() ? (
                      <IconActionButton
                        icon="ti ti-pencil"
                        title={t.editEventDetails}
                        onClick={() => void handleEdit()}
                        disabled={isLoading()}
                      />
                    ) : undefined
                  }
                >
                  <DescriptionList
                    layout="rows"
                    size="sm"
                    items={[
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
                    ]}
                  />
                </DetailPanel.Section>
              </Show>
              <Show when={canShowInvitations()}>
                <EventInvitations spaceId={props.spaceId} itemId={props.item.id} />
              </Show>
            </DetailPanel.Group>
          </Show>

          <Show
            when={
              props.item.description ||
              (!isEvent() && (canEditItem() || (props.attachments?.some((attachment) => attachment.kind === "image") ?? false)))
            }
          >
            <DetailPanel.Group label={t.content}>
              <Show when={props.item.description}>
                <DetailPanel.Section
                  class="[view-transition-name:space-item-detail-description]"
                  title={t.description}
                  icon="ti ti-align-left"
                  tone="neutral"
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
              <Show when={!isEvent()}>
                <TaskAttachmentsSection
                  spaceId={props.spaceId}
                  itemId={props.item.id}
                  attachments={props.attachments ?? []}
                  canWrite={canEditItem()}
                  onChanged={reconcileAfterWrite}
                />
              </Show>
            </DetailPanel.Group>
          </Show>

          <Show when={!isEvent() && (canEditItem() || (props.checklist?.length ?? 0) > 0)}>
            <DetailPanel.Group label={t.progress}>
              <DetailPanel.Section
                title={t.checklist}
                icon="ti ti-list-check"
                tone="neutral"
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
            </DetailPanel.Group>
          </Show>

          <Show
            when={
              !isEvent() &&
              (canEditItem() || (props.blockedBy?.length ?? 0) > 0 || (props.blocks?.length ?? 0) > 0 || linkedResources().length > 0)
            }
          >
            <DetailPanel.Group label={t.taskContext}>
              <DetailPanel.Section title={t.blockedBy} icon="ti ti-lock" tone={activeBlockerCount() > 0 ? "warning" : "neutral"}>
                <div class="flex flex-col gap-1">
                  <For each={props.blockedBy ?? []}>
                    {(dependency) => {
                      const leading = (
                        <i
                          class={`ti ${dependency.blocker.completedAt ? "ti-circle-check text-[var(--k2b-success-text)]" : "ti-lock text-amber-600 dark:text-amber-400"}`}
                          aria-hidden="true"
                        />
                      );
                      return canEditItem() ? (
                        <DetailPanel.Action
                          href={itemHref(dependency.blocker.id)}
                          leading={leading}
                          title={dependency.blocker.title}
                          description={dependency.blocker.completedAt ? t.completed : t.activeBlocker}
                          menuLabel={`More actions for ${dependency.blocker.title}`}
                          menuItems={[
                            {
                              label: t.removeBlocker,
                              icon: "ti ti-unlink",
                              disabled: removeBlocker.loading(),
                              action: () => removeBlocker.mutate(dependency.blocker.id),
                            },
                          ]}
                        />
                      ) : (
                        <DetailPanel.Action
                          href={itemHref(dependency.blocker.id)}
                          leading={leading}
                          title={dependency.blocker.title}
                          description={dependency.blocker.completedAt ? t.completed : t.activeBlocker}
                          trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                        />
                      );
                    }}
                  </For>
                  <Show when={canEditItem()}>
                    <Combobox
                      aria-label={t.addTaskBlocker}
                      placeholder={t.blockerSearchPlaceholder}
                      fetchData={blockerOptions}
                      onSelect={(option) => addBlocker.mutate(option.id)}
                      disabled={addBlocker.loading() || removeBlocker.loading()}
                    />
                  </Show>
                </div>
              </DetailPanel.Section>
              <Show when={(props.blocks?.length ?? 0) > 0}>
                <DetailPanel.Section title={t.blocks} icon="ti ti-git-branch" tone="neutral" meta={props.blocks?.length}>
                  <div class="flex flex-col gap-1">
                    <For each={props.blocks ?? []}>
                      {(dependency) => (
                        <DetailPanel.Action
                          href={itemHref(dependency.dependent.id)}
                          leading={
                            <i
                              class={`ti ${dependency.dependent.completedAt ? "ti-circle-check text-[var(--k2b-success-text)]" : "ti-lock text-amber-600 dark:text-amber-400"}`}
                              aria-hidden="true"
                            />
                          }
                          title={dependency.dependent.title}
                          description={dependency.dependent.completedAt ? t.completed : t.blockedByThisTask}
                          trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                        />
                      )}
                    </For>
                  </div>
                </DetailPanel.Section>
              </Show>
              {linkedResourcesSection()}
            </DetailPanel.Group>
          </Show>

          <Show when={isEvent() && (canEditItem() || linkedResources().length > 0)}>
            <DetailPanel.Group label={t.resourceContext}>{linkedResourcesSection()}</DetailPanel.Group>
          </Show>

          <Show when={relatedTasks().length > 0}>
            <DetailPanel.Section title={t.relatedTasks} icon="ti ti-list-details" tone="neutral">
              <div class="flex flex-col gap-1">
                <For each={relatedTasks()}>
                  {(reference) => {
                    const href = () => reference.resource?.links?.find((link) => link.rel === "open")?.href;
                    const menu = () =>
                      canEditItem()
                        ? {
                            menuLabel: `More actions for ${reference.label}`,
                            menuItems: [
                              {
                                label: t.unlink,
                                icon: "ti ti-unlink",
                                disabled: unlinkReference.loading(),
                                action: () => unlinkReference.mutate(reference.ref),
                              },
                            ],
                          }
                        : {};
                    return (
                      <Show
                        when={href()}
                        fallback={
                          <DetailPanel.Action
                            type="button"
                            disabled
                            leading={<i class="ti ti-checkbox" aria-hidden="true" />}
                            title={reference.label}
                            description={t.taskUnavailable}
                            {...menu()}
                          />
                        }
                      >
                        {(openHref) => (
                          <DetailPanel.Action
                            href={openHref()}
                            leading={<i class="ti ti-checkbox" aria-hidden="true" />}
                            title={reference.label}
                            description={reference.resource?.title !== reference.label ? reference.resource?.title : undefined}
                            trailing={!canEditItem() ? <i class="ti ti-chevron-right" aria-hidden="true" /> : undefined}
                            {...menu()}
                          />
                        )}
                      </Show>
                    );
                  }}
                </For>
              </div>
            </DetailPanel.Section>
          </Show>

          <Show when={canShowClassification() || canShowAssignees()}>
            <DetailPanel.Group label={t.organization}>
              <Show when={canShowClassification()}>
                <DetailPanel.Section title={t.classify} icon="ti ti-tags" tone="accent">
                  <div class="grid grid-cols-1 gap-3">
                    <Show
                      when={canEditItem()}
                      fallback={
                        <div>
                          <h4 class="section-label mb-1">{t.priority}</h4>
                          <Show when={selectedPriority()} fallback={<span class="text-xs text-secondary">{t.noPriority}</span>}>
                            {(priority) => (
                              <Tag color={priority().color} icon={priority().icon}>
                                {priority().label}
                              </Tag>
                            )}
                          </Show>
                        </div>
                      }
                    >
                      <Select
                        label={t.priority}
                        placeholder={t.noPriority}
                        icon="ti ti-flag"
                        value={selectedPriorityValue}
                        options={priorityOptions.map((option) => ({ id: option.value, ...option }))}
                        onValueChange={updatePriority}
                        disabled={isLoading()}
                        clearable
                      />
                    </Show>
                    <Show
                      when={canEditItem()}
                      fallback={
                        <div>
                          <h4 class="section-label mb-1">{t.tags}</h4>
                          <div class="flex min-h-8 flex-wrap items-center gap-1.5">
                            <Show
                              when={(props.item.tags?.length ?? 0) > 0}
                              fallback={<span class="text-xs text-secondary">{t.noTags}</span>}
                            >
                              {props.item.tags?.map((tag) => (
                                <Tag color={tag.color} size="sm">
                                  {tag.name}
                                </Tag>
                              ))}
                            </Show>
                          </div>
                        </div>
                      }
                    >
                      <MultiSelectInput
                        label={t.tags}
                        placeholder={t.noTags}
                        searchPlaceholder={t.searchTags}
                        icon="ti ti-tags"
                        value={selectedTagIds}
                        options={props.tags.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
                        onValueChange={updateTags}
                        disabled={isLoading()}
                        clearable
                      />
                    </Show>
                  </div>
                </DetailPanel.Section>
              </Show>

              <Show when={canShowAssignees()}>
                <DetailPanel.Section title={t.assignees} icon="ti ti-users" tone="neutral">
                  <AssigneesSection
                    spaceId={props.spaceId}
                    assignees={props.item.assignees ?? []}
                    onUpdate={(ids) => updateMutation.mutate({ assigneeIds: ids })}
                    loading={isLoading()}
                    disabled={!canEditItem()}
                  />
                </DetailPanel.Section>
              </Show>
            </DetailPanel.Group>
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
              onUpdate={() => void commentsQuery.invalidate().catch(() => prompts.error(t.commentRefreshAfterSaveFailed))}
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
            />
          </Show>

          <DetailPanel.Group label={t.itemMetadata}>
            <DetailPanel.Section title={t.itemInformation} icon="ti ti-info-circle" tone="neutral" collapsible>
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
    </div>
  );
}
