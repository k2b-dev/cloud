import type { DateContext } from "@k2b/stdlib";
import { Checkbox, ScrollArea, useLocale } from "@k2b/ui";
import { createUniqueId, For, Show } from "solid-js";
import type { SpaceItem } from "@/contracts";
import { shouldHandleDetailClick } from "../../../lib/detail";
import { useSpaceMessages } from "../../messages";
import { requestSpacesRouteNavigation } from "../workspace/workspace-events";
import type { TimelineTray as Tray } from "../workspace/workspace-types";
import type { TimelineTraySection } from "./timeline";

type Props = {
  tray: Tray;
  /** Whether the reader may check tasks off. */
  canCheck: boolean;
  /** Checkbox states the reader just set, shown until the refresh after the change is in. */
  checking: Record<string, boolean>;
  onToggle: (itemId: string, completed: boolean) => void;
  itemHref: (item: SpaceItem) => string;
  /** The list view with every task of a part, or undefined where the filter rules the part out. */
  listHref: (section: TimelineTraySection) => string | undefined;
  dateConfig?: DateContext;
  class?: string;
};

/**
 * Tasks the timeline has no place for, in one fixed row below it: open tasks whose deadline passed before today, and
 * open tasks of the reader without a deadline. The row keeps its height whatever it holds, so the strip never moves
 * when tasks come or go; more tasks than fit scroll sideways. It comes first in the document, so a screen reader and
 * the keyboard reach what is overdue before the days of the strip.
 */
export default function TimelineTray(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  /** The due day as the strip's day headings name it, such as "Tue, Oct 6": a weekday alone is ambiguous here. */
  const dueDay = (deadline: string) =>
    new Intl.DateTimeFormat(props.dateConfig?.locale ?? locale(), {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: props.dateConfig?.timeZone,
    }).format(new Date(deadline));
  const empty = () => props.tray.overdue.items.length === 0 && props.tray.undated.items.length === 0;

  const Section = (section: { kind: TimelineTraySection; label: string; allLabel: (count: number) => string }) => {
    const headingId = createUniqueId();
    const list = () => props.tray[section.kind];
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
                <li
                  class="flex h-7 max-w-72 shrink-0 items-center gap-1.5 rounded-full bg-[var(--ui-surface-muted)] px-2.5 text-xs"
                  data-spaces-tray-item={item.id}
                >
                  <Show when={props.canCheck && !blocked()}>
                    <Checkbox
                      aria-label={`${t.markComplete}: ${item.title}`}
                      value={props.checking[item.id] ?? false}
                      // Until the change is in, so a second click cannot leave the box out of step with it.
                      disabled={item.id in props.checking}
                      onValueChange={(completed) => props.onToggle(item.id, completed)}
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
                </li>
              );
            }}
          </For>
          <Show when={list().total > list().items.length}>
            <li class="shrink-0">
              <a
                href={props.listHref(section.kind)}
                aria-label={section.allLabel(list().total)}
                class="focus-ui flex h-7 items-center rounded-full px-2 text-xs font-medium text-dimmed hover:app-accent-text"
              >
                {t.timelineTrayShowAll}
              </a>
            </li>
          </Show>
        </ul>
      </Show>
    );
  };

  return (
    <section aria-label={t.timelineTray} class={`flex h-11 shrink-0 items-center ${props.class ?? ""}`} data-spaces-timeline-tray>
      <Show
        when={!empty()}
        fallback={
          <p class="flex items-center gap-1.5 px-1 text-xs text-dimmed">
            <i class="ti ti-circle-check" aria-hidden="true" />
            {t.timelineTrayEmpty}
          </p>
        }
      >
        <ScrollArea orientation="horizontal" class="no-scrollbar min-w-0 flex-1">
          <div class="flex w-max items-center gap-2 px-1 py-2">
            <Section kind="overdue" label={t.overdue} allLabel={(count) => t.timelineTrayAllOverdue({ count })} />
            <Section kind="undated" label={t.timelineTrayUndated} allLabel={(count) => t.timelineTrayAllUndated({ count })} />
          </div>
        </ScrollArea>
      </Show>
    </section>
  );
}
