import type { CalendarEvent, CalendarEventRenderContext } from "@k2b/ui";
import { For, Show } from "solid-js";
import { CALENDAR_PRIORITY_COLORS } from "./colors";

/** Further tags or assignees beyond the item color; more would not fit beside a title. */
const MAX_EXTRA_DOTS = 3;

/**
 * The text of a Spaces calendar item, with the time, place, and description rules of the default `@k2b/ui` event.
 * One line holds the task checkbox, the title, a red flag for urgent and high priority, and dots for further
 * colors. Every part keeps the line's height, and the dots appear only when the item is wide enough, so a different
 * color mode never moves anything.
 */
export function CalendarItemContent(props: {
  event: CalendarEvent;
  context: CalendarEventRenderContext;
  task: boolean;
  flag: { label: string } | null;
  extra: string[];
  /** A lock before the title, for an entry that only says the time is taken. */
  busy?: boolean;
}) {
  // The day and week views size a band's title and time themselves; the item adds its flag and further colors.
  if (props.context.timeline) return <TimelineContent {...props} />;
  const showTime = () => !props.context.allDay && !props.context.compact && props.context.durationHours >= 0.75;
  const showLocation = () => Boolean(props.event.location && !props.context.compact && props.context.durationHours >= 1.25);
  const showDescription = () =>
    Boolean(
      props.event.description?.trim() &&
        props.context.fill &&
        !props.context.allDay &&
        !props.context.compact &&
        props.context.durationHours >= 1.5,
    );
  return (
    <span class="@container flex min-w-0 flex-1 flex-col" data-spaces-calendar-item="">
      <span class="flex min-w-0 items-center gap-1">
        <Show when={props.task}>
          {/* Mixed with the text color, so a very light or dark tag color still reads on both themes. */}
          <i
            class="ti ti-checkbox shrink-0 text-[0.75rem] leading-none"
            style={{ color: "color-mix(in srgb, var(--k2b-calendar-accent) 75%, currentColor)" }}
            aria-hidden="true"
          />
        </Show>
        <Show when={props.busy}>
          <i class="ti ti-lock shrink-0 text-[0.75rem] leading-none opacity-70" aria-hidden="true" />
        </Show>
        <Show when={props.context.leadingTime}>
          {/* The month view's start time, before the title as in the default event. */}
          <span class="shrink-0 text-[0.6875rem] font-medium tabular-nums opacity-70 in-[.k2b-calendar-day-list]:text-[0.8125rem] max-md:in-[.k2b-calendar-month]:hidden">
            {props.context.leadingTime}
          </span>
        </Show>
        <span class="min-w-0 truncate text-[0.6875rem] font-medium in-[.k2b-calendar-day-list]:text-[0.8125rem] [[data-bar=true]_&]:font-semibold [[data-selected=true]_&]:font-semibold">
          {props.event.title}
        </span>
        <Show when={props.flag}>
          {(flag) => (
            <i
              class="ti ti-flag shrink-0 text-[0.6875rem] leading-none"
              style={{ color: CALENDAR_PRIORITY_COLORS.urgent }}
              title={flag().label}
              aria-hidden="true"
              data-spaces-calendar-flag=""
            />
          )}
        </Show>
        <Show when={props.extra.length > 0}>
          <span class="hidden shrink-0 items-center gap-0.5 @min-[7rem]:flex" aria-hidden="true" data-spaces-calendar-dots="">
            <For each={props.extra.slice(0, MAX_EXTRA_DOTS)}>
              {(color) => <span class="size-1.5 rounded-full" style={{ "background-color": color }} />}
            </For>
          </span>
        </Show>
      </span>
      <Show when={showTime()}>
        <span class="mt-1 block truncate text-[0.625rem] opacity-70">{props.context.timeLabel}</span>
      </Show>
      <Show when={showLocation()}>
        <span class="block truncate text-[0.625rem] opacity-70" classList={{ "mt-1": !showTime() }}>
          {props.event.location}
        </span>
      </Show>
      <Show when={showDescription()}>
        <span class="mt-1 line-clamp-2 text-[0.625rem] leading-[1.35] text-[var(--k2b-text-muted)]">{props.event.description}</span>
      </Show>
    </span>
  );
}

/** A band, a deadline, or an all-day entry of the day and week views, in the calendar's own parts. */
function TimelineContent(props: {
  event: CalendarEvent;
  context: CalendarEventRenderContext;
  flag: { label: string } | null;
  extra: string[];
  busy?: boolean;
}) {
  const band = () => props.context.fill && !props.context.allDay;
  return (
    <>
      <Show when={props.context.leadingTime}>
        <span class="k2b-calendar-event__time">{props.context.leadingTime}</span>
      </Show>
      <span class="k2b-calendar-event__title" data-spaces-calendar-item="">
        <Show when={props.busy}>
          <i class="ti ti-lock mr-0.5 opacity-70" aria-hidden="true" />
        </Show>
        {props.event.title}
      </span>
      <Show when={band()}>
        <span class="k2b-calendar-event__meta">
          {props.context.timeLabel}
          <Show when={props.context.remaining}>
            <span class="k2b-calendar-event__remaining"> · {props.context.remaining}</span>
          </Show>
          <Show when={props.extra.length > 0}>
            <span class="ml-1 inline-flex items-center gap-0.5 align-middle" aria-hidden="true" data-spaces-calendar-dots="">
              <For each={props.extra.slice(0, MAX_EXTRA_DOTS)}>
                {(color) => <span class="size-1.5 rounded-full" style={{ "background-color": color }} />}
              </For>
            </span>
          </Show>
        </span>
      </Show>
      <Show when={props.flag}>
        {(flag) => (
          <i
            class="ti ti-flag k2b-calendar-event__flag"
            style={{ color: CALENDAR_PRIORITY_COLORS.urgent }}
            title={flag().label}
            aria-hidden="true"
            data-spaces-calendar-flag=""
          />
        )}
      </Show>
    </>
  );
}
