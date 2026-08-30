import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, Tag, toast } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { INACTIVE_ITEM_DAYS, type SpaceColumn, type SpaceItem, type SpaceTag } from "@/contracts";
import { shouldHandleDetailClick, subscribeToDetailSelection } from "../../../lib/detail";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import { isInactiveTask } from "../shared/item-activity";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";

type ItemRowProps = {
  item: SpaceItem;
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  isSelected: boolean;
  /** Base URL for item links (without item param) */
  baseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  agenda?: boolean;
};

const PRIORITY_STYLES: Record<string, { icon: string; color: string }> = {
  urgent: { icon: "ti-alert-circle", color: "text-red-500" },
  high: { icon: "ti-arrow-up", color: "text-orange-500" },
  medium: { icon: "ti-minus", color: "text-yellow-500" },
  low: { icon: "ti-arrow-down", color: "text-blue-500" },
};

const formatEstimate = (minutes: number) => {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`;
};

/**
 * Item row - displays item info and links to detail view.
 * Only the completion toggle is interactive here.
 */
export default function ItemRow(props: ItemRowProps) {
  const t = useSpaceMessages();
  const [isSelectedLocal, setIsSelectedLocal] = createSignal(props.isSelected);

  createEffect(() => {
    setIsSelectedLocal(props.isSelected);
  });

  onMount(() => {
    const unsubscribe = subscribeToDetailSelection(({ itemId }) => {
      setIsSelectedLocal(itemId === props.item.id);
    });
    onCleanup(unsubscribe);
  });

  const completeMutation = mutations.create<boolean, boolean>({
    mutation: async (completed: boolean) => {
      const res = await apiClient[":id"].items[":itemId"].completed.$post({
        param: { id: props.spaceId, itemId: props.item.id },
        json: { completed },
      });
      if (!res.ok) {
        throw new Error(await readResponseError(res, t.updateFailed));
      }
      await res.json();
      return completed;
    },
    onSuccess: (completed) => {
      toast.success(completed ? t.itemCompleted : t.itemReopened);
      void invalidateSpacesData().catch(() => prompts.error(t.listRefreshFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const isCompleted = () => !!props.item.completedAt;
  const completionBlocked = () => !isCompleted() && props.item.activeBlockerCount > 0;
  const isEvent = () => !!(props.item.startsAt && props.item.endsAt);
  const priority = () => (props.item.priority ? PRIORITY_STYLES[props.item.priority] : null);
  const status = () => props.columns.find((column) => column.id === props.item.columnId) ?? null;
  const isOverdue = () => props.item.deadline && new Date(props.item.deadline) < new Date() && !isCompleted();
  const schedule = () => (isEvent() ? props.item.startsAt : props.item.deadline) ?? null;
  const eventTime = () => {
    if (!isEvent()) return null;
    if (props.item.allDay) return t.allDay;
    return `${dates.formatTime(props.item.startsAt!, props.dateConfig)}–${dates.formatTime(props.item.endsAt!, props.dateConfig)}`;
  };
  const hasMetadata = () =>
    !!status() ||
    (!props.agenda && !!schedule()) ||
    (!props.agenda && isEvent()) ||
    props.item.activeBlockerCount > 0 ||
    props.item.estimatedDurationMinutes !== null ||
    isInactiveTask(props.item) ||
    (props.item.tags?.length ?? 0) > 0;
  const titleTone = () => {
    if (isSelectedLocal()) return isCompleted() ? "app-accent-text line-through" : "app-accent-text";
    if (isCompleted()) return "line-through text-dimmed";
    return "text-secondary group-hover:app-accent-text group-focus-within:app-accent-text";
  };

  const itemUrl = () => {
    const sep = props.baseUrl.includes("?") ? "&" : "?";
    return `${props.baseUrl}${sep}item=${props.item.id}`;
  };
  return (
    <div class="group flex min-h-12 items-center gap-3 px-2.5 py-2 focus-within:relative focus-within:z-10">
      {/* Completion Toggle */}
      <Show
        when={props.canWrite}
        fallback={
          <span
            role="img"
            class={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
              isCompleted()
                ? "border-emerald-500 bg-emerald-500 text-white"
                : `${isSelectedLocal() ? "app-accent-border" : "border-[var(--ui-border)]"} bg-[var(--ui-surface-muted)] text-dimmed`
            }`}
            aria-label={isCompleted() ? t.completed : t.active}
          >
            <Show when={isCompleted()}>
              <i class="ti ti-check text-xs" />
            </Show>
          </span>
        }
      >
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            completeMutation.mutate(!isCompleted());
          }}
          disabled={completeMutation.loading() || completionBlocked()}
          title={completionBlocked() ? t.completeBlockersFirst : undefined}
          class={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
            isCompleted()
              ? "border-emerald-500 bg-emerald-500 text-white [box-shadow:inset_0_1px_0_0_rgb(255_255_255/0.35)]"
              : completionBlocked()
                ? "cursor-not-allowed border-[var(--ui-field-border)] bg-[var(--ui-surface-muted)] opacity-50"
                : `${isSelectedLocal() ? "app-accent-border" : "border-[var(--ui-field-border)]"} bg-[var(--ui-field)] hover:border-emerald-500`
          }`}
          aria-label={isCompleted() ? t.markIncomplete : t.markComplete}
        >
          <Show when={isCompleted() || completeMutation.loading()}>
            <i class={`ti ${completeMutation.loading() ? "ti-loader-2 animate-spin" : "ti-check"} text-xs`} />
          </Show>
        </button>
      </Show>

      {/* Item Link - Main content area */}
      <a
        href={itemUrl()}
        class="focus-ui flex min-w-0 flex-1 items-center gap-3 rounded-[var(--ui-radius-control)]"
        aria-current={isSelectedLocal() ? "true" : undefined}
        onClick={(event) => {
          if (!shouldHandleDetailClick(event, event.currentTarget)) return;
          event.preventDefault();
          requestSpacesRouteNavigation(itemUrl(), { scroll: "preserve" });
        }}
      >
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <Show when={props.agenda && eventTime()}>
              <span class="shrink-0 text-xs font-medium tabular-nums text-purple-600 dark:text-purple-300">{eventTime()}</span>
            </Show>
            <Show when={priority()}>
              <i class={`ti ${priority()!.icon} ${priority()!.color} shrink-0 text-sm`} />
            </Show>
            <span class={`block truncate text-sm font-medium transition-colors ${titleTone()}`}>{props.item.title}</span>
          </div>
          <Show when={hasMetadata()}>
            <div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-dimmed">
              <Show when={status()}>
                <span class="inline-flex min-w-0 items-center gap-1">
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full" style={`background-color:${status()!.color ?? "#6b7280"}`} />
                  <span class="truncate">{status()!.name}</span>
                </span>
              </Show>
              <Show when={!props.agenda && schedule()}>
                <span class={`inline-flex shrink-0 items-center gap-1 ${isOverdue() ? "text-red-500" : ""}`}>
                  <i class={`ti ${isEvent() ? "ti-calendar-event" : "ti-clock"}`} />
                  {dates.formatDateRelative(schedule()!, props.dateConfig)}
                </span>
              </Show>
              <Show when={!props.agenda && isEvent()}>
                <span class="inline-flex items-center gap-1 text-[11px] text-purple-600 dark:text-purple-300">
                  <i class="ti ti-calendar-event" /> {t.event}
                </span>
              </Show>
              <Show when={props.item.estimatedDurationMinutes !== null}>
                <span class="inline-flex shrink-0 items-center gap-1">
                  <i class="ti ti-hourglass" aria-hidden="true" />
                  {formatEstimate(props.item.estimatedDurationMinutes!)}
                </span>
              </Show>
              <Show when={props.item.activeBlockerCount > 0}>
                <span class="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-300">
                  <i class="ti ti-lock" aria-hidden="true" />
                  Blocked by {props.item.activeBlockerCount}
                </span>
              </Show>
              <Show when={isInactiveTask(props.item)}>
                <span class="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-300">
                  <i class="ti ti-clock-pause" aria-hidden="true" />
                  {t.inactiveFor({ days: INACTIVE_ITEM_DAYS })}
                </span>
              </Show>
              <For each={props.item.tags?.slice(0, 2) ?? []}>
                {(tag) => (
                  <Tag size="sm" color={tag.color} class="max-w-24">
                    {tag.name}
                  </Tag>
                )}
              </For>
              <Show when={(props.item.tags?.length ?? 0) > 2}>
                <span class="text-[11px] text-dimmed">+{props.item.tags!.length - 2}</span>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={props.item.assignees?.length}>
          <div class="shrink-0">
            <AssigneeAvatars assignees={props.item.assignees!} />
          </div>
        </Show>
      </a>
    </div>
  );
}
