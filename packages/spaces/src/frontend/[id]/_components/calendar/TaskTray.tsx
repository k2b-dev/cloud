import type { DateContext } from "@k2b/stdlib";
import { Checkbox, ScrollArea, toast, useLocale } from "@k2b/ui";
import { createComputed, createSignal, createUniqueId, For, type JSX, onCleanup, Show, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SpaceItem } from "@/contracts";
import { shouldHandleDetailClick } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { type ClaimFields, resolveCompletionClaim } from "../shared/claim/claim";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
import { createLeavingItems, keepHeld, snapshotOf } from "../shared/leaving";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import type { CalendarTray as Tray } from "../workspace/workspace-types";
import type { TaskTraySection } from "./tray";

type Props = {
  spaceId: string;
  /** The tasks to show, or null while the day that brings them loads; the row keeps its place meanwhile. */
  tray: Tray | null;
  /** Whether the calendar's filter narrows the tray; an empty tray then says so. */
  filtered: boolean;
  /** Whether the reader may check tasks off. */
  canCheck: boolean;
  /** The reader, whose own claim on a task goes with checking it off. */
  currentUserId?: string;
  itemHref: (item: SpaceItem) => string;
  /** The list view with every task of a part, or undefined where the filter rules the part out. */
  listHref: (section: TaskTraySection) => string | undefined;
  dateConfig?: DateContext;
};

const emptyTray: Tray = { overdue: { items: [], total: 0 }, undated: { items: [], total: 0 } };

/**
 * Tasks a day has no place for, in one fixed row below the day view: open tasks whose deadline passed before today,
 * and open tasks of the reader without a deadline. The row keeps its height whatever it holds, so the day never moves
 * when tasks come or go; more tasks than fit scroll sideways. It follows the day in the document as on screen, so Tab
 * and a screen reader reach it in the order the reader sees.
 */
export default function TaskTray(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const retryToast = createRetryToasts();
  /** Checkbox states the reader just set, shown until the refresh after the change is in. */
  const [checking, setChecking] = createSignal<Record<string, boolean>>({});
  const settle = (id: string) =>
    setChecking((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const refresh = (): Promise<void> => invalidateSpacesData().catch(() => retryToast(t.calendarRefreshFailed, t.retry, () => refresh()));
  /** Tasks checked off here stay in the row, done, for a moment after the refresh drops them, then shrink away. */
  const leaving = createLeavingItems<SpaceItem>();
  /** The Undo of each task checked off here, while its toast offers it. */
  const undos = new Map<string, () => void>();
  /** Whether the tray as loaded has the task; a task leaves it once it is completed. */
  const inTray = (id: string) =>
    [...(props.tray?.overdue.items ?? []), ...(props.tray?.undated.items ?? [])].some((item) => item.id === id);
  /** A task the reader claimed completes with that claim; one claimed by someone else asks once to take it over. */
  const toggle = async (item: SpaceItem, completed: boolean) => {
    if (item.id in checking()) return;
    // Unticking a task that is still leaving is its Undo.
    const pendingUndo = undos.get(item.id);
    if (pendingUndo && leaving.held().has(item.id)) return pendingUndo();
    // The box shows the tick at once; declining to take a claim over clears it again.
    setChecking((current) => ({ ...current, [item.id]: completed }));
    const previous = snapshotOf(item);
    const claim: ClaimFields | null = props.currentUserId
      ? await resolveCompletionClaim(item.claim, props.currentUserId, completed, t)
      : {};
    if (!claim) return settle(item.id);
    const done = { ...previous, completedAt: completed ? new Date().toISOString() : null };
    leaving.hold(done);
    let changed: SpaceItem;
    try {
      changed = await setItemCompleted({ spaceId: props.spaceId, itemId: item.id, completed, ...claim }, t.updateFailed);
    } catch (error) {
      settle(item.id);
      leaving.release(item.id);
      toast.error(error instanceof Error ? error.message : t.updateFailed);
      return;
    }
    await refresh();
    settle(item.id);
    if (inTray(item.id)) return leaving.release(item.id);
    leaving.leave(item.id);
    // The task leaves the tray, so the toast confirms it and offers Undo, which puts the task back in its place, also
    // while it is still leaving.
    const undo = confirmCompletion({ spaceId: props.spaceId, previous, changed, currentUserId: props.currentUserId }, t, {
      undoing: () => {
        // The box shows the task as it was again and ignores clicks until Undo is through.
        setChecking((current) => ({ ...current, [item.id]: !completed }));
        leaving.hold(previous);
      },
      undone: (restored) => {
        settle(item.id);
        if (restored) {
          undos.delete(item.id);
          return leaving.release(item.id);
        }
        leaving.hold(done);
        leaving.leave(item.id);
      },
    });
    undos.set(item.id, undo);
  };
  // A task keeps its row while it stays in the tray, so a refresh that brings the same tasks again, such as after a
  // change elsewhere in the Space, leaves keyboard focus where it is. A task just checked off keeps its place a moment.
  const [tray, setTray] = createStore<Tray>({ overdue: { items: [], total: 0 }, undated: { items: [], total: 0 } });
  createComputed(() => {
    const next = props.tray ?? emptyTray;
    const held = leaving.held();
    untrack(() =>
      setTray(
        reconcile({
          overdue: { ...next.overdue, items: keepHeld(tray.overdue.items, next.overdue.items, held) },
          undated: { ...next.undated, items: keepHeld(tray.undated.items, next.undated.items, held) },
        }),
      ),
    );
  });
  let region: HTMLElement | undefined;

  /**
   * A row that leaves while it holds keyboard focus, such as a task just checked off, hands focus to the row that takes
   * its place, else to the row before it, else to the tray itself, so the next Tab does not start over at the top.
   */
  const handOffFocus = (row: HTMLElement) => {
    const container = region;
    const focused = document.activeElement;
    if (!container || !focused || !row.contains(focused)) return;
    const rows = () => [...container.querySelectorAll<HTMLElement>("li")];
    const position = rows().indexOf(row);
    const control = focused instanceof HTMLInputElement ? "input" : "a";
    queueMicrotask(() => {
      // The whole tray left with the row, or focus has already moved on.
      if (!container.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
      const remaining = rows();
      const next = remaining[Math.min(position, remaining.length - 1)];
      (next?.querySelector<HTMLElement>(control) ?? next?.querySelector<HTMLElement>("input, a") ?? container).focus();
    });
  };
  const Row = (row: { item?: string; class: string; onClick?: JSX.EventHandler<HTMLLIElement, MouseEvent>; children: JSX.Element }) => {
    let element: HTMLLIElement | undefined;
    onCleanup(() => element && handOffFocus(element));
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: it only watches the clicks of the checkbox inside, which Space fires too.
      <li ref={element} class={row.class} data-spaces-tray-item={row.item} onClick={row.onClick}>
        {row.children}
      </li>
    );
  };

  /** The due day with its date, such as "Tue, Oct 6": a weekday alone is ambiguous here. */
  const dueDay = (deadline: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale ?? locale(), {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(deadline));
  const empty = () => tray.overdue.items.length === 0 && tray.undated.items.length === 0;

  const Section = (section: { kind: TaskTraySection; label: string; allLabel: (count: number) => string }) => {
    const headingId = createUniqueId();
    const list = () => tray[section.kind];
    return (
      <Show when={list().items.length > 0}>
        <h3
          id={headingId}
          class={`shrink-0 text-[11px] font-semibold uppercase tracking-wide ${
            section.kind === "overdue" ? "text-red-600 dark:text-red-400" : "text-dimmed"
          } [&:not(:first-child)]:ml-3`}
        >
          {section.label}
        </h3>
        <ul aria-labelledby={headingId} class="flex shrink-0 items-center gap-2">
          <For each={list().items}>
            {(item) => {
              const blocked = () => item.activeBlockerCount > 0;
              const href = () => props.itemHref(item);
              const collapsing = () => leaving.collapsing(item.id);
              return (
                // A task that leaves shrinks to nothing, gap included, so the tasks after it slide over instead of jumping.
                <Row
                  item={item.id}
                  class={`grid shrink-0 transition-[grid-template-columns,margin,opacity] duration-200 ease-out motion-reduce:transition-none ${
                    collapsing() ? "-mr-2 grid-cols-[0fr] overflow-hidden opacity-0" : "grid-cols-[1fr]"
                  }`}
                  onClick={(event) => {
                    // Until the change is in, the box ignores another click or Space, so it cannot get out of step with
                    // the change. Unlike disabling it, this keeps keyboard focus on the box.
                    if (event.target instanceof HTMLInputElement && item.id in checking()) event.preventDefault();
                  }}
                >
                  <div
                    class={`flex h-7 min-w-0 max-w-72 items-center gap-1.5 rounded-full bg-[var(--ui-surface-muted)] px-2.5 text-xs ${
                      collapsing() ? "overflow-hidden" : ""
                    }`}
                  >
                    <Show when={props.canCheck && !blocked()}>
                      <Checkbox
                        aria-label={`${t.markComplete}: ${item.title}`}
                        value={checking()[item.id] ?? Boolean(item.completedAt)}
                        onValueChange={(completed) => void toggle(item, completed)}
                      />
                    </Show>
                    <Show when={blocked()}>
                      <i class="ti ti-lock shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
                    </Show>
                    <a
                      href={href()}
                      class="focus-ui flex min-w-0 items-center gap-1.5 rounded-[var(--ui-radius-control)] text-secondary hover:app-accent-text"
                      onClick={(event) => {
                        if (!shouldHandleDetailClick(event, event.currentTarget)) return;
                        event.preventDefault();
                        requestSpacesRouteNavigation(href(), { scroll: "preserve" });
                      }}
                    >
                      <span class={`truncate font-medium ${item.completedAt ? "text-dimmed line-through" : ""}`}>{item.title}</span>
                      <Show when={section.kind === "overdue" && item.deadline}>
                        {(deadline) => (
                          <span class="shrink-0 tabular-nums text-red-600 dark:text-red-400">
                            <span class="sr-only">{t.deadline}: </span>
                            {dueDay(deadline())}
                          </span>
                        )}
                      </Show>
                      <Show when={blocked()}>
                        <span class="sr-only">, {t.blockedByCount({ count: item.activeBlockerCount })}</span>
                      </Show>
                    </a>
                  </div>
                </Row>
              );
            }}
          </For>
          <Show when={list().total > list().items.length}>
            <Row class="shrink-0">
              {/* The name starts with the visible words, so voice control finds the link by what it shows. */}
              <a
                href={props.listHref(section.kind)}
                aria-label={section.allLabel(list().total)}
                class="focus-ui flex h-7 items-center rounded-full px-2 text-xs font-medium text-dimmed hover:app-accent-text"
              >
                {t.taskTrayShowAll}
              </a>
            </Row>
          </Show>
        </ul>
      </Show>
    );
  };

  return (
    <section
      ref={region}
      // Where focus lands once the last task left.
      tabIndex={-1}
      aria-label={t.taskTray}
      aria-busy={props.tray ? undefined : "true"}
      class="focus-ui flex h-11 shrink-0 items-center"
      data-spaces-task-tray
    >
      <Show
        when={!empty()}
        fallback={
          <Show when={props.tray}>
            <p class="flex items-center gap-1.5 px-1 text-xs text-dimmed">
              <i class="ti ti-circle-check" aria-hidden="true" />
              {props.filtered ? t.taskTrayEmptyFiltered : t.taskTrayEmpty}
            </p>
          </Show>
        }
      >
        {/* It contains the words only a screen reader hears, which sit absolutely, so they scroll with their task
            instead of reaching past the page. */}
        <ScrollArea orientation="horizontal" class="no-scrollbar relative min-w-0 flex-1">
          <div class="flex w-max items-center gap-2 px-1 py-2">
            <Section kind="overdue" label={t.overdue} allLabel={(count) => t.taskTrayAllOverdue({ count })} />
            <Section kind="undated" label={t.taskTrayUndated} allLabel={(count) => t.taskTrayAllUndated({ count })} />
          </div>
        </ScrollArea>
      </Show>
    </section>
  );
}
