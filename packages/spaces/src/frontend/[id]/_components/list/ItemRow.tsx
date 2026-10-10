import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Checkbox, Tag } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { INACTIVE_ITEM_DAYS, type SpaceColumn, type SpaceItem, type SpaceTag } from "@/contracts";
import { shouldHandleDetailClick, subscribeToDetailSelection } from "../../../lib/detail";
import type { RetryToast } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import { type ClaimFields, resolveCompletionClaim } from "../shared/claim/claim";
import { setItemCompleted, showCompletion } from "../shared/completion";
import { isInactiveTask } from "../shared/item-activity";
import { type LeavingItems, snapshotOf } from "../shared/leaving";
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
  currentUserId: string;
  agenda?: boolean;
  /** Whether the list shows the item now; a filter can hide a row once it is completed or reopened. */
  isListed: (itemId: string) => boolean;
  /** Keeps a row the filters drop after a tick in view for a moment, done, before it collapses. */
  leaving: LeavingItems<SpaceItem>;
  /** The list around the rows, where focus goes on when a row with focus leaves. */
  list: () => HTMLElement | undefined;
  /** Owned by the list, so a Retry toast stays open when a refresh renders the rows again. */
  retryToast: RetryToast;
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

  /** The state the reader just set, shown from the tick until the list has it. */
  const [ticked, setTicked] = createSignal<boolean | null>(null);
  type Completion = { completed: boolean; claim: ClaimFields; previous: SpaceItem };
  const completeMutation = mutations.create<SpaceItem, Completion, Completion>({
    onBefore: (vars) => vars,
    mutation: ({ completed, claim }) =>
      setItemCompleted({ spaceId: props.spaceId, itemId: props.item.id, completed, ...claim }, t.updateFailed),
    // A row the list's filters now hide stays a moment as the reader left it, then collapses; the toast confirms it and
    // offers Undo, which puts it back in place. The row of a task tagged several times shows in several groups, so the
    // list owns what the rows show and the Undo.
    onSuccess: (changed, context) => {
      if (!context) return;
      const { completed, previous } = context;
      const change = { spaceId: props.spaceId, previous, changed, currentUserId: props.currentUserId, completed };
      const view = {
        leaving: props.leaving,
        isListed: props.isListed,
        refreshFailed: () => props.retryToast(t.listRefreshFailed, t.retry, refreshList),
      };
      void showCompletion(change, view, t).then(() => setTicked(null));
    },
    onError: (err, context) => {
      setTicked(null);
      props.leaving.release(props.item.id);
      props.retryToast(err.message, t.retry, () => context && void tick(context.completed, context.claim));
    },
  });
  /**
   * Shows the new state at once and keeps the row where it is until the list knows whether it stays. The row keeps
   * the place the task had before the change, such as among the overdue tasks, until it has left.
   */
  const tick = (completed: boolean, claim: ClaimFields) => {
    const previous = snapshotOf(props.item);
    setTicked(completed);
    props.leaving.hold(previous, completed);
    return completeMutation.mutate({ completed, claim, previous });
  };
  /** A task someone else claimed asks once to take the claim over; declining changes nothing. */
  const toggleCompleted = async (completed: boolean) => {
    if (busy()) return;
    // Unticking a row that is still leaving is its Undo.
    const undo = props.leaving.undo(props.item.id);
    if (undo) return undo();
    // The box shows the tick at once; declining to take a claim over clears it again.
    setTicked(completed);
    const claim = await resolveCompletionClaim(props.item.claim, props.currentUserId, completed, t);
    if (claim) await tick(completed, claim);
    else setTicked(null);
  };
  const refreshList = (): void => void invalidateSpacesData().catch(() => props.retryToast(t.listRefreshFailed, t.retry, refreshList));
  const isCompleted = () => ticked() ?? props.leaving.completed(props.item.id) ?? !!props.item.completedAt;
  /** A change of the task or its Undo runs: a held row that offers no Undo has one under way. */
  const busy = () =>
    ticked() !== null || completeMutation.loading() || (props.leaving.held().has(props.item.id) && !props.leaving.undo(props.item.id));
  const collapsing = () => props.leaving.collapsing(props.item.id);
  let row: HTMLDivElement | undefined;
  // A row that leaves while it holds keyboard focus hands it to the same control of the row that takes its place, else
  // of the row before it, so the reader can go on ticking tasks off with the keyboard.
  onMount(() =>
    onCleanup(() => {
      const list = props.list();
      const focused = document.activeElement;
      if (!row || !list || !focused || !row.contains(focused)) return;
      const rows = () => [...list.querySelectorAll<HTMLElement>("[data-space-list-row]")];
      const position = rows().indexOf(row);
      const control = focused.matches("input") ? "input" : "a";
      queueMicrotask(() => {
        if (!list.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
        const remaining = rows();
        remaining[Math.min(position, remaining.length - 1)]?.querySelector<HTMLElement>(control)?.focus();
      });
    }),
  );
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
    // A row the list dropped collapses smoothly once it has shown its new state; nothing else moves meanwhile.
    <div
      ref={row}
      data-space-list-row
      class={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
        collapsing() ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"
      }`}
    >
      <div class={`min-h-0 ${collapsing() ? "overflow-hidden" : ""}`}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: it only watches the clicks of the checkbox inside, which Space fires too. */}
        <div
          class="group flex min-h-12 items-center gap-3 px-2.5 py-2 focus-within:relative focus-within:z-10"
          onClick={(event) => {
            // Until the change is in, the box ignores another click or Space, so it cannot get out of step with the
            // change. Unlike disabling it, this keeps keyboard focus on the box.
            if (event.target instanceof Element && event.target.matches("input") && busy()) event.preventDefault();
          }}
        >
          <span class="flex shrink-0" title={props.canWrite && completionBlocked() ? t.completeBlockersFirst : undefined}>
            <Checkbox
              // A reader who cannot change the task hears its title and whether it is checked.
              aria-label={props.canWrite ? `${t.markComplete}: ${props.item.title}` : props.item.title}
              value={isCompleted()}
              disabled={!props.canWrite || completionBlocked()}
              onValueChange={(completed) => void toggleCompleted(completed)}
            />
          </span>

          {/* Item Link - Main content area. It paints over the checkbox's touch area, so a tap on the task opens it. */}
          <a
            href={itemUrl()}
            class="focus-ui relative flex min-w-0 flex-1 items-center gap-3 rounded-[var(--ui-radius-control)]"
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
      </div>
    </div>
  );
}
