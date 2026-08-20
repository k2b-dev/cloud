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
} from "@k2b/ui";
import { openCloudResourcePicker } from "@valentinkolb/cloud/browser/resource-picker";
import { createEffect, createSignal, For, Show } from "solid-js";
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
import { openEditItemDialog, saveItemFormData } from "../shared/editItem";
import SpaceAssigneePicker from "../shared/SpaceAssigneePicker";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import type { SpaceItemDetail } from "../workspace/workspace-types";
import { canTransferThroughWormhole, showWormholeTransferToast, transferThroughWormhole } from "../wormhole-transfer";
import CommentsSection from "./CommentsSection";
import EventInvitations from "./EventInvitations";
import TaskAttachmentsSection from "./TaskAttachmentsSection";

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

const PRIORITY_OPTIONS = [
  {
    value: "urgent",
    label: "Urgent",
    icon: "ti ti-alert-circle",
    color: "#ef4444",
  },
  { value: "high", label: "High", icon: "ti ti-arrow-up", color: "#f97316" },
  { value: "medium", label: "Medium", icon: "ti ti-minus", color: "#eab308" },
  { value: "low", label: "Low", icon: "ti ti-arrow-down", color: "#3b82f6" },
] as const;

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
  return (
    <SpaceAssigneePicker
      spaceId={props.spaceId}
      value={() => props.assignees}
      onChange={(next) => props.onUpdate(next.map((assignee) => assignee.id))}
      disabled={props.loading || props.disabled}
      variant="rows"
      placeholder="Search people with access..."
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
  const reconcileAfterWrite = () =>
    void invalidateSpacesData().catch(() => prompts.error("Changes were saved, but item data could not be refreshed."));
  const [selectedPriorityValue, setSelectedPriorityValue] = createSignal<string | null>(props.item.priority);
  const [selectedTagIds, setSelectedTagIds] = createSignal(props.item.tags?.map((tag) => tag.id) ?? []);
  let selectedItemId = props.item.id;

  const unlinkReference = mutations.create<void, { type: string; id: string }>({
    mutation: async (ref, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].references.$delete(
        { param: { id: props.spaceId, itemId: props.item.id }, json: { ref } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to unlink resource"));
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
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to link resource"));
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
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to add blocker"));
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
      if (!response.ok) throw new Error(await readResponseError(response, "Failed to remove blocker"));
    },
    onSuccess: () => reconcileAfterWrite(),
    onError: (error) => prompts.error(error.message),
  });

  const linkCloudResource = async () => {
    const selected = await openCloudResourcePicker({
      title: "Link Cloud resource",
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
    if (!response.ok) throw new Error(await readResponseError(response, "Failed to search tasks"));
    const excluded = new Set([props.item.id, ...(props.blockedBy ?? []).map((dependency) => dependency.blocker.id)]);
    return (await response.json()).items
      .filter((item) => !excluded.has(item.id))
      .map((item) => ({
        id: item.id,
        label: item.title,
        description: item.completedAt ? "Completed" : "Active",
        icon: item.completedAt ? "ti-circle-check" : "ti-checkbox",
      }));
  };

  createEffect(() => {
    if (props.item.id === selectedItemId) return;
    selectedItemId = props.item.id;
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
      throw new Error(await readResponseError(res, "Failed to update"));
    }
    return (await res.json()) as SpaceItem;
  };

  const handleItemUpdated = (item: SpaceItem | null) => {
    if (!item) return;
    toast.success("Item updated");
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
    if (!res.ok) throw new Error(await readResponseError(res, "Failed to refresh comments"));
    return res.json();
  };

  const commentsSource = `${props.commentTarget.itemId}:${props.commentTarget.recurrenceId ?? "series"}`;
  const commentsQuery = query.createInfinite<string, SpaceItemDetail["comments"], number>({
    source: () => commentsSource,
    initial: { source: commentsSource, pages: [props.initialCommentsPage] },
    loadPage: async (_source, { cursor, abortSignal }) => {
      const page = cursor ?? 1;
      const result = await loadCommentsPage(page, abortSignal);
      if (result.page !== page) throw new Error("The server returned an invalid comments page.");
      return result;
    },
    getNextCursor: (page) => (page.hasNext ? page.page + 1 : null),
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
        throw new Error(await readResponseError(res, "Failed to update"));
      }
      await res.json();
      return completed;
    },
    onSuccess: (completed) => {
      toast.success(completed ? "Item completed" : "Item reopened");
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
      if (!res.ok) throw new Error(await readResponseError(res, "Failed to duplicate item"));
      return res.json();
    },
    onSuccess: () => {
      toast.success("Item duplicated");
      reconcileAfterWrite();
    },
    onError: (err) => prompts.error(err.message),
  });

  const deleteMutation = mutations.create<void, { itemId: string }>({
    mutation: async ({ itemId }) => {
      const res = await apiClient[":id"].items[":itemId"].$delete({
        param: { id: props.spaceId, itemId },
      });
      if (!res.ok) throw new Error(await readResponseError(res, "Failed to delete item"));
    },
    onSuccess: () => {
      toast.success("Item deleted");
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
      }),
    onSuccess: (result) => {
      showWormholeTransferToast(result);
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
      const confirmed = await prompts.confirm(`Are you sure you want to delete "${props.item.title}"?`, {
        title: "Delete Item",
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: "Delete",
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
      toast.success("Item updated");
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
      if (data) void editItemMutation.mutate({ spaceId: props.spaceId, itemId: props.item.id, data });
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
        label: "Edit item",
        icon: "ti ti-pencil",
        action: () => void handleEdit(),
      },
      {
        label: "Duplicate item",
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
                  label: `Move to ${wormhole.target.spaceName} / ${wormhole.target.columnName}`,
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
          label: "Delete item",
          icon: "ti ti-trash",
          variant: "danger",
          action: handleDelete,
        },
      ],
    });
    return actions;
  };

  const scheduleTitle = () => (isEvent() ? "Event time" : "Deadline");
  const selectedPriority = () => PRIORITY_OPTIONS.find((option) => option.value === selectedPriorityValue());

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
    <DetailPanel.Section title="Linked resources" icon="ti ti-link" tone="neutral">
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
                        label: "Unlink",
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
                    description="Resource unavailable or no longer accessible"
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
            title="Link Cloud resource"
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
          subtitle={isEvent() ? "Event" : "Task"}
          meta={
            <>
              <span class="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium leading-4 text-[var(--k2b-success-text)]">
                <span class="h-1 w-1 rounded-full bg-[var(--k2b-success-500)]" aria-hidden="true" />
                {isCompleted() ? "Completed" : "Active"}
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
                  <Dropdown.Trigger iconOnly label="More item actions" tooltip="More item actions">
                    <i class="ti ti-dots" aria-hidden="true" />
                  </Dropdown.Trigger>
                </Dropdown.Root>
              </Show>
              <Tooltip.Anchor content="Close details">
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
                  aria-label="Close item details"
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
                    title={completionBlocked() ? "Complete all blocking tasks first" : undefined}
                    variant={isCompleted() || completionBlocked() ? "secondary" : "success"}
                    size="sm"
                    class={
                      isCompleted()
                        ? "text-emerald-700 dark:text-emerald-300"
                        : completionBlocked()
                          ? "!border-transparent !bg-[var(--k2b-warning-500)] !text-white disabled:!opacity-60"
                          : undefined
                    }
                  >
                    <Show when={isCompleted() || completeMutation.loading()}>
                      <i class={`ti ${completeMutation.loading() ? "ti-loader-2 animate-spin" : "ti-check"}`} aria-hidden="true" />
                    </Show>
                    <Show when={!isCompleted() && !completeMutation.loading()}>
                      <i class={`ti ${completionBlocked() ? "ti-lock" : "ti-circle-check"}`} aria-hidden="true" />
                    </Show>
                    {isCompleted() ? "Reopen" : completionBlocked() ? `Blocked by ${activeBlockerCount()}` : "Mark complete"}
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
                    title={isEvent() ? "Edit event time" : "Edit deadline"}
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
                            { term: "Deadline", description: dates.formatDateTime(props.item.deadline) },
                            { term: "Due", description: dates.formatTimeSpan(props.item.deadline) },
                          ]
                        : []),
                      ...(props.item.estimatedDurationMinutes
                        ? [{ term: "Estimate", description: formatEstimatedDuration(props.item.estimatedDurationMinutes) }]
                        : []),
                    ]}
                  />
                }
              >
                <DescriptionList
                  layout="rows"
                  size="sm"
                  items={[
                    { term: "Start", description: dates.formatDateTime(scheduleStart()!) },
                    { term: "End", description: dates.formatDateTime(scheduleEnd()!) },
                    { term: "Duration", description: dates.formatDuration(scheduleStart()!, scheduleEnd()!) },
                    ...(recurrenceSummary()
                      ? [
                          {
                            term: "Repeat",
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
            <DetailPanel.Group label="Event context">
              <Show when={props.item.location || props.item.url}>
                <DetailPanel.Section
                  title="Event details"
                  icon="ti ti-map-pin"
                  tone="accent"
                  actions={
                    canEditItem() ? (
                      <IconActionButton
                        icon="ti ti-pencil"
                        title="Edit event details"
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
                      ...(props.item.location ? [{ term: "Location", description: props.item.location }] : []),
                      ...(props.item.url
                        ? [
                            {
                              term: "URL",
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
            <DetailPanel.Group label="Content">
              <Show when={props.item.description}>
                <DetailPanel.Section
                  class="[view-transition-name:space-item-detail-description]"
                  title="Description"
                  icon="ti ti-align-left"
                  tone="neutral"
                  actions={
                    canEditItem() ? (
                      <IconActionButton
                        icon="ti ti-pencil"
                        title="Edit description"
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

          <Show
            when={
              !isEvent() &&
              (canEditItem() || (props.blockedBy?.length ?? 0) > 0 || (props.blocks?.length ?? 0) > 0 || linkedResources().length > 0)
            }
          >
            <DetailPanel.Group label="Task context">
              <DetailPanel.Section title="Blocked by" icon="ti ti-lock" tone={activeBlockerCount() > 0 ? "warning" : "neutral"}>
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
                          description={dependency.blocker.completedAt ? "Completed" : "Active blocker"}
                          menuLabel={`More actions for ${dependency.blocker.title}`}
                          menuItems={[
                            {
                              label: "Remove blocker",
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
                          description={dependency.blocker.completedAt ? "Completed" : "Active blocker"}
                          trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                        />
                      );
                    }}
                  </For>
                  <Show when={canEditItem()}>
                    <Combobox
                      aria-label="Add task blocker"
                      placeholder="Search tasks to add as blockers"
                      fetchData={blockerOptions}
                      onSelect={(option) => addBlocker.mutate(option.id)}
                      disabled={addBlocker.loading() || removeBlocker.loading()}
                    />
                  </Show>
                </div>
              </DetailPanel.Section>
              <Show when={(props.blocks?.length ?? 0) > 0}>
                <DetailPanel.Section title="Blocks" icon="ti ti-git-branch" tone="neutral" meta={props.blocks?.length}>
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
                          description={dependency.dependent.completedAt ? "Completed" : "Blocked by this task"}
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
            <DetailPanel.Group label="Resource context">{linkedResourcesSection()}</DetailPanel.Group>
          </Show>

          <Show when={relatedTasks().length > 0}>
            <DetailPanel.Section title="Related tasks" icon="ti ti-list-details" tone="neutral">
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
                                label: "Unlink",
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
                            description="Task unavailable or no longer accessible"
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
            <DetailPanel.Group label="Organization">
              <Show when={canShowClassification()}>
                <DetailPanel.Section title="Classify" icon="ti ti-tags" tone="accent">
                  <div class="grid grid-cols-1 gap-3">
                    <Show
                      when={canEditItem()}
                      fallback={
                        <div>
                          <h4 class="section-label mb-1">Priority</h4>
                          <Show when={selectedPriority()} fallback={<span class="text-xs text-secondary">No priority</span>}>
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
                        label="Priority"
                        placeholder="No priority"
                        icon="ti ti-flag"
                        value={selectedPriorityValue}
                        options={PRIORITY_OPTIONS.map((option) => ({ id: option.value, ...option }))}
                        onValueChange={updatePriority}
                        disabled={isLoading()}
                        clearable
                      />
                    </Show>
                    <Show
                      when={canEditItem()}
                      fallback={
                        <div>
                          <h4 class="section-label mb-1">Tags</h4>
                          <div class="flex min-h-8 flex-wrap items-center gap-1.5">
                            <Show when={(props.item.tags?.length ?? 0) > 0} fallback={<span class="text-xs text-secondary">No tags</span>}>
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
                        label="Tags"
                        placeholder="No tags"
                        searchPlaceholder="Search tags..."
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
                <DetailPanel.Section title="Assignees" icon="ti ti-users" tone="neutral">
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
              onUpdate={() =>
                void commentsQuery.invalidate().catch(() => prompts.error("Comment saved, but comments could not be refreshed."))
              }
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
            />
          </Show>

          <DetailPanel.Group label="Item metadata">
            <DetailPanel.Section title="Item information" icon="ti ti-info-circle" tone="neutral" collapsible>
              <DescriptionList
                layout="rows"
                size="sm"
                items={[
                  { term: "Created", description: dates.formatDateTime(props.item.createdAt) },
                  { term: "Updated", description: dates.formatDateTime(props.item.updatedAt) },
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
