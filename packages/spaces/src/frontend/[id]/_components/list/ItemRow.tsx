import { cloudAvatarSource } from "@k2b/cloud/account/ui";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Row } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount } from "solid-js";
import { INACTIVE_ITEM_DAYS, type SpaceColumn, type SpaceItem } from "@/contracts";
import { formatDeadline } from "@/presentation/deadline";
import { isTaskOverdue } from "@/task-overdue";
import type { RetryToast } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { type ClaimFields, resolveCompletionClaim } from "../shared/claim/claim";
import { setItemCompleted, showCompletion } from "../shared/completion";
import { isInactiveTask } from "../shared/item-activity";
import { type LeavingItems, snapshotOf } from "../shared/leaving";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";

type ItemRowProps = {
  item: SpaceItem;
  spaceId: string;
  columns: SpaceColumn[];
  isSelected: boolean;
  /** Base URL for item links (without item param) */
  baseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
  /** The list groups by day: the day stands in the group, the row shows the time of an event. */
  agenda?: boolean;
  /** Whether the list shows the item now; a filter can hide a row once it is completed or reopened. */
  isListed: (itemId: string) => boolean;
  /** Keeps a row the filters drop after a tick in view for a moment, done, before it leaves. */
  leaving: LeavingItems<SpaceItem>;
  /** The list around the rows, where focus goes on when a row with focus leaves. */
  list: () => HTMLElement | undefined;
  /** Owned by the list, so a Retry toast stays open when a refresh renders the rows again. */
  retryToast: RetryToast;
};

const priorityIcon = { urgent: "alert-circle", high: "arrow-up", medium: "minus", low: "arrow-down" } as const;

export const formatEstimate = (minutes: number) => {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`;
};

/** A status's colour; a done status without its own is green, as on the board, an open one stays untinted. */
export const statusColor = (column: Pick<SpaceColumn, "color" | "isDone">) => column.color ?? (column.isDone ? "#10b981" : undefined);

/**
 * The people of an item as the row names them: whoever works on it first (as "… is on it" with `onIt`), then the other
 * assignees.
 */
export const itemPeople = (item: SpaceItem, onIt?: (values: { name: string }) => string) => [
  ...(item.claim ? [onIt ? onIt({ name: item.claim.displayName }) : item.claim.displayName] : []),
  ...(item.assignees ?? []).filter((assignee) => assignee.id !== item.claim?.actor.id).map((assignee) => assignee.displayName),
];

/**
 * One task or event of the list: its status, when, how urgent, and who; the row opens the item beside the list. A
 * task is ticked off at the end of the row; a row the filters then hide stays a moment, done, and Undo puts it back.
 */
export default function ItemRow(props: ItemRowProps) {
  const t = useSpaceMessages();
  /** The state the reader just set, shown from the tick until the list has it. */
  const [ticked, setTicked] = createSignal<boolean | null>(null);
  type Completion = { completed: boolean; claim: ClaimFields; previous: SpaceItem };
  const completeMutation = mutations.create<SpaceItem, Completion, Completion>({
    onBefore: (vars) => vars,
    mutation: ({ completed, claim }) =>
      setItemCompleted({ spaceId: props.spaceId, itemId: props.item.id, completed, ...claim }, t.updateFailed),
    // A row the list's filters now hide stays a moment as the reader left it; the toast confirms it and offers Undo,
    // which puts it back in place. The list owns what the rows show and the Undo.
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

  const itemUrl = () => `${props.baseUrl}${props.baseUrl.includes("?") ? "&" : "?"}item=${props.item.id}`;
  // A row that leaves while it holds the focus hands it to the row that takes its place, else the one before it, so
  // the reader can go on ticking tasks off with the keyboard.
  onMount(() =>
    onCleanup(() => {
      const list = props.list();
      const rows = () => [...(list?.querySelectorAll<HTMLElement>('[data-k2-part="Row"]') ?? [])];
      const row = [...(list?.querySelectorAll("a[href]") ?? [])]
        .find((link) => link.getAttribute("href") === itemUrl())
        ?.closest<HTMLElement>('[data-k2-part="Row"]');
      const focused = document.activeElement;
      if (!list || !row || !focused || !row.contains(focused)) return;
      const position = rows().indexOf(row);
      // the done toggle (a pressed or unpressed button) hands focus to the next row's toggle, the link to its link
      const control = focused.matches("button[aria-pressed]") ? "button[aria-pressed]" : "a";
      queueMicrotask(() => {
        if (!list.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
        const remaining = rows();
        remaining[Math.min(position, remaining.length - 1)]?.querySelector<HTMLElement>(control)?.focus();
      });
    }),
  );

  const isEvent = () => !!(props.item.startsAt && props.item.endsAt);
  const status = () => props.columns.find((column) => column.id === props.item.columnId) ?? null;
  const priorityLabel = () =>
    props.item.priority ? { urgent: t.urgent, high: t.high, medium: t.medium, low: t.low }[props.item.priority] : null;
  const when = () => {
    if (isEvent()) {
      const time = props.item.allDay
        ? t.allDay
        : `${dates.formatTime(props.item.startsAt!, props.dateConfig)}–${dates.formatTime(props.item.endsAt!, props.dateConfig)}`;
      return props.agenda ? time : `${dates.formatDateRelative(props.item.startsAt!, props.dateConfig)}, ${time}`;
    }
    return props.item.deadline && !props.agenda ? formatDeadline(props.item.deadline, props.dateConfig) : undefined;
  };
  /** The second line: everything the row says about the item besides its title, in one quiet sentence. */
  const details = () => {
    const tags = props.item.tags ?? [];
    return [
      status()?.name,
      // Grouped by day, the "Overdue" group already says it.
      !props.agenda && !isCompleted() && isTaskOverdue(props.item, props.dateConfig) ? t.overdue : undefined,
      priorityLabel(),
      props.item.estimatedDurationMinutes !== null ? formatEstimate(props.item.estimatedDurationMinutes) : undefined,
      props.item.activeBlockerCount > 0 ? t.blockedByCount({ count: props.item.activeBlockerCount }) : undefined,
      isInactiveTask(props.item) ? t.inactiveFor({ days: INACTIVE_ITEM_DAYS }) : undefined,
      itemPeople(props.item, t.onIt).join(", ") || undefined,
      tags.length
        ? `${tags
            .slice(0, 2)
            .map((tag) => tag.name)
            .join(", ")}${tags.length > 2 ? ` +${tags.length - 2}` : ""}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  };
  const blocked = () => !isCompleted() && props.item.activeBlockerCount > 0;
  const person = () => {
    const claim = props.item.claim;
    const first = props.item.assignees?.[0];
    const who = claim
      ? { name: claim.displayName, id: claim.actor.kind === "user" ? claim.actor.id : null, hash: claim.avatarHash }
      : first
        ? { name: first.displayName, id: first.kind === "user" ? first.id : null, hash: first.avatarHash }
        : null;
    return who ? { name: who.name, image: who.id && who.hash ? cloudAvatarSource(who.id, who.hash) : undefined } : undefined;
  };
  return (
    <Row
      // The person who works on the task, else the first one assigned, leads the row; without one, its kind in the status colour.
      avatar={person()}
      mark={
        person()
          ? undefined
          : {
              icon: isEvent()
                ? "calendar-event"
                : props.item.priority
                  ? priorityIcon[props.item.priority]
                  : isCompleted()
                    ? "circle-check"
                    : "circle",
              color: status() ? statusColor(status()!) : undefined,
            }
      }
      lines={details() ? [props.item.title, details()] : [props.item.title]}
      time={when()}
      current={props.isSelected}
      href={itemUrl()}
      onNavigate={() => requestSpacesRouteNavigation(itemUrl(), { scroll: "preserve" })}
      end={
        isEvent() ? undefined : (
          // k2b-ui gap: a Row has no task check in its lead (`select` means selection); a toggle with the round symbol
          // of a task stands at the end, named for assistive technology only, so the title keeps the row's width.
          <Button
            variant="ghost"
            icon={isCompleted() ? "circle-check" : "circle"}
            // A reader who cannot change the task hears its title and whether it is done.
            label={props.canWrite ? `${t.markComplete}: ${props.item.title}` : props.item.title}
            pressed={isCompleted()}
            busy={busy()}
            disabled={!props.canWrite || blocked()}
            onClick={() => void toggleCompleted(!isCompleted())}
          />
        )
      }
    />
  );
}
