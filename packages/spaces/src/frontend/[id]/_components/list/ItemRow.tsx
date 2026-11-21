import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Checkbox, StatusBadge, Tag } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { INACTIVE_ITEM_DAYS, type SpaceColumn, type SpaceItem, type SpaceTag } from "@/contracts";
import { formatDeadline } from "@/presentation/deadline";
import { isTaskOverdue } from "@/task-overdue";
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
  /** The list is not grouped by status, so each row names its status after the title. */
  showStatus?: boolean;
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
  urgent: { icon: "ti-alert-circle", color: "text-red-600" },
  high: { icon: "ti-arrow-up", color: "text-orange-600" },
  medium: { icon: "ti-minus", color: "text-yellow-600" },
  low: { icon: "ti-arrow-down", color: "text-blue-600" },
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
  const priorityLabel: Record<string, string> = { urgent: t.urgent, high: t.high, medium: t.medium, low: t.low };
  const priority = () =>
    props.item.priority ? { ...PRIORITY_STYLES[props.item.priority]!, label: priorityLabel[props.item.priority] ?? "" } : null;
  const status = () => props.columns.find((column) => column.id === props.item.columnId) ?? null;
  const isOverdue = (): boolean => !isCompleted() && isTaskOverdue(props.item, props.dateConfig);
  const schedule = () => (isEvent() ? props.item.startsAt : props.item.deadline) ?? null;
  const eventTime = () => {
    if (!isEvent()) return null;
    if (props.item.allDay) return t.allDay;
    return `${dates.formatTime(props.item.startsAt!, props.dateConfig)}–${dates.formatTime(props.item.endsAt!, props.dateConfig)}`;
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
      data-collapsing={collapsing() ? "true" : undefined}
      class={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
        collapsing() ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]"
      }`}
    >
      <div class={`min-h-0 ${collapsing() ? "overflow-hidden" : ""}`}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: it only watches the clicks of the checkbox inside, which Space fires too. */}
        <div
          class="spaces-list-row"
          data-selected={isSelectedLocal() ? "" : undefined}
          data-done={isCompleted() ? "" : undefined}
          onClick={(event) => {
            // Until the change is in, the box ignores another click or Space, so it cannot get out of step with the
            // change. Unlike disabling it, this keeps keyboard focus on the box.
            if (event.target instanceof Element && event.target.matches("input") && busy()) event.preventDefault();
          }}
        >
          {/* On touch, the box's hit area reaches past this cell on purpose; the layout self-check skips it. */}
          <span
            class="spaces-list-row__check"
            data-layout-check="skip"
            title={props.canWrite && completionBlocked() ? t.completeBlockersFirst : undefined}
          >
            <Checkbox
              // A reader who cannot change the task hears its title and whether it is checked.
              aria-label={props.canWrite ? `${t.markComplete}: ${props.item.title}` : props.item.title}
              value={isCompleted()}
              disabled={!props.canWrite || completionBlocked()}
              onValueChange={(completed) => void toggleCompleted(completed)}
            />
          </span>

          {/* The link is the rest of the row, cell by cell on the list's column grid (K7). It paints over the checkbox's
              touch area, so a tap on the task opens it. */}
          <a
            href={itemUrl()}
            class="spaces-list-row__link"
            data-spaces-item-link
            aria-current={isSelectedLocal() ? "true" : undefined}
            onClick={(event) => {
              if (!shouldHandleDetailClick(event, event.currentTarget)) return;
              event.preventDefault();
              requestSpacesRouteNavigation(itemUrl(), { scroll: "preserve" });
            }}
          >
            <span class="spaces-list-row__main">
              <Show when={props.agenda && eventTime()}>
                <span class="spaces-list-row__time">{eventTime()}</span>
              </Show>
              <Show when={isEvent() && !props.agenda}>
                <i class="ti ti-calendar-event spaces-list-row__kind" aria-hidden="true" />
                <span class="sr-only">{t.eventKind}</span>
              </Show>
              <span class="spaces-list-row__title" title={props.item.title}>
                {props.item.title}
              </span>
              {/* Without its date column, an overdue row says so at its title (K15). */}
              <Show when={isOverdue()}>
                <StatusBadge tone="error" variant="dot" label={t.overdue} class="spaces-list-row__overdue" />
              </Show>
              {/* Hints after the title go as a whole before the title is cut (K15). */}
              <Show when={props.showStatus && status()}>
                <span class="spaces-list-row__hint">
                  <span class="spaces-list-row__dot" style={`background-color:${status()!.color ?? "#6b7280"}`} aria-hidden="true" />
                  {status()!.name}
                </span>
              </Show>
              <Show when={props.item.activeBlockerCount > 0}>
                <span class="spaces-list-row__hint" data-state>
                  <i class="ti ti-lock" aria-hidden="true" />
                  {t.blockedByCount({ count: props.item.activeBlockerCount })}
                </span>
              </Show>
              <Show when={props.item.estimatedDurationMinutes !== null}>
                <span class="spaces-list-row__hint">
                  <i class="ti ti-hourglass" aria-hidden="true" />
                  {formatEstimate(props.item.estimatedDurationMinutes!)}
                </span>
              </Show>
              <Show when={isInactiveTask(props.item)}>
                <span class="spaces-list-row__hint" data-tone="warning">
                  <i class="ti ti-clock-pause" aria-hidden="true" />
                  {t.inactiveFor({ days: INACTIVE_ITEM_DAYS })}
                </span>
              </Show>
            </span>
            <span class="spaces-list-row__priority">
              <Show
                when={priority()}
                fallback={
                  <span class="spaces-list-row__none" aria-hidden="true">
                    —
                  </span>
                }
              >
                {(meta) => (
                  <>
                    <i class={`ti ${meta().icon} ${meta().color}`} aria-hidden="true" />
                    {meta().label}
                  </>
                )}
              </Show>
            </span>
            <span class="spaces-list-row__date" data-overdue={isOverdue() ? "" : undefined}>
              <Show
                when={schedule()}
                fallback={
                  <span class="spaces-list-row__none" aria-hidden="true">
                    —
                  </span>
                }
              >
                {(when) => (
                  <>
                    {isEvent()
                      ? `${dates.formatDateRelative(when(), props.dateConfig)}${eventTime() && !props.agenda ? `, ${eventTime()}` : ""}`
                      : formatDeadline(when(), props.dateConfig)}
                    <Show when={isOverdue()}> · {t.overdue}</Show>
                  </>
                )}
              </Show>
            </span>
            <span class="spaces-list-row__tags">
              <For each={props.item.tags?.slice(0, 2) ?? []}>
                {(tag) => (
                  <Tag color={tag.color} class="max-w-24">
                    {tag.name}
                  </Tag>
                )}
              </For>
              <Show when={(props.item.tags?.length ?? 0) > 2}>
                <span class="spaces-list-row__more">+{props.item.tags!.length - 2}</span>
              </Show>
            </span>
            {/* Below 640 px of list, the cells give way to one quiet second line (K7: two lines on a phone). */}
            <span class="spaces-list-row__meta">
              {[
                priority()?.label,
                schedule()
                  ? `${isEvent() ? dates.formatDateRelative(schedule()!, props.dateConfig) : formatDeadline(schedule()!, props.dateConfig)}${isOverdue() ? ` · ${t.overdue}` : ""}`
                  : undefined,
                ...(props.item.tags?.map((tag) => tag.name) ?? []),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span class="spaces-list-row__people">
              <Show
                when={props.item.assignees?.length || props.item.claim}
                fallback={
                  <span class="spaces-list-row__none" aria-hidden="true">
                    —
                  </span>
                }
              >
                <AssigneeAvatars assignees={props.item.assignees ?? []} claim={props.item.claim} currentUserId={props.currentUserId} />
              </Show>
            </span>
          </a>
        </div>
      </div>
    </div>
  );
}
