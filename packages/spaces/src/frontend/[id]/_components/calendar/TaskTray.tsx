import type { DateContext } from "@k2b/stdlib";
import { Checkbox, ScrollArea, toast, useLocale } from "@k2b/ui";
import { createComputed, createSignal, createUniqueId, For, type JSX, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { SpaceItem } from "@/contracts";
import { shouldHandleDetailClick } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import { ownClaimId } from "../shared/claim/claim";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
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
  /** A task the reader claimed completes with that claim; one claimed by someone else is refused with the reason. */
  const toggle = async (item: SpaceItem, completed: boolean) => {
    if (item.id in checking()) return;
    setChecking((current) => ({ ...current, [item.id]: completed }));
    const claimId = props.currentUserId ? ownClaimId(item.claim, props.currentUserId) : undefined;
    try {
      await setItemCompleted({ spaceId: props.spaceId, itemId: item.id, completed, claimId }, t.updateFailed);
    } catch (error) {
      settle(item.id);
      toast.error(error instanceof Error ? error.message : t.updateFailed);
      return;
    }
    // A completed task leaves the tray with the refresh, so the toast confirms it and offers Undo.
    confirmCompletion({ spaceId: props.spaceId, itemId: item.id, completed }, t);
    await refresh();
    settle(item.id);
  };
  // A task keeps its row while it stays in the tray, so a refresh that brings the same tasks again, such as after a
  // change elsewhere in the Space, leaves keyboard focus where it is.
  const [tray, setTray] = createStore<Tray>({ overdue: { items: [], total: 0 }, undated: { items: [], total: 0 } });
  createComputed(() => setTray(reconcile(props.tray ?? emptyTray)));
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
              return (
                <Row
                  item={item.id}
                  class="flex h-7 max-w-72 shrink-0 items-center gap-1.5 rounded-full bg-[var(--ui-surface-muted)] px-2.5 text-xs"
                  onClick={(event) => {
                    // Until the change is in, the box ignores another click or Space, so it cannot get out of step with
                    // the change. Unlike disabling it, this keeps keyboard focus on the box.
                    if (event.target instanceof HTMLInputElement && item.id in checking()) event.preventDefault();
                  }}
                >
                  <Show when={props.canCheck && !blocked()}>
                    <Checkbox
                      aria-label={`${t.markComplete}: ${item.title}`}
                      value={checking()[item.id] ?? false}
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
                    <span class="truncate font-medium">{item.title}</span>
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
        <ScrollArea orientation="horizontal" class="no-scrollbar min-w-0 flex-1">
          <div class="flex w-max items-center gap-2 px-1 py-2">
            <Section kind="overdue" label={t.overdue} allLabel={(count) => t.taskTrayAllOverdue({ count })} />
            <Section kind="undated" label={t.taskTrayUndated} allLabel={(count) => t.taskTrayAllUndated({ count })} />
          </div>
        </ScrollArea>
      </Show>
    </section>
  );
}
