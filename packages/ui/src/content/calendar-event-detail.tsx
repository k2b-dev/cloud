import { dates as calendar } from "@k2b/stdlib";
import type { JSX } from "solid-js";
import { createEffect, For, Show } from "solid-js";
import { ButtonLink, IconButton } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { Avatar } from "../surfaces/Avatar";
import type { CalendarEvent } from "./Calendar";
import { useCalendarMessages } from "./calendar-messages";
import { type CalendarOwner, eventHref, followCalendarHref, isOverdue, ownerDateConfig, placeCalendarPopover } from "./calendar-shared";

/** The entry the calendar's own detail shows, and the element that opened it, where the focus returns. */
export type CalendarDetailState = { event: CalendarEvent & { sourceStartDate?: Date; sourceEndDate?: Date }; anchor: HTMLElement };

const DAY_MS = 86_400_000;
const PHONE = "(max-width: 47.999rem)";

/**
 * The calendar's own detail of an entry, for hosts without `onEventActivate`: its time, place, people, and links, and
 * "Open" for its `href`. It lies beside the entry, and on a phone it rises from the bottom. Escape and a click outside
 * close it, and the focus goes back to the entry.
 */
export const CalendarEventDetail = (props: {
  owner: CalendarOwner;
  state: CalendarDetailState | null;
  onClose: () => void;
}): JSX.Element => {
  const ui = useUiMessages();
  const messages = useCalendarMessages();
  let element: HTMLDivElement | undefined;
  const config = () => ownerDateConfig(props.owner);
  const day = (date: Date) =>
    date.toLocaleDateString(config().locale ?? "en", { weekday: "long", day: "numeric", month: "long", timeZone: config().timeZone });
  const when = (event: CalendarDetailState["event"]) => {
    const start = event.sourceStartDate ?? new Date(event.start);
    const end = event.sourceEndDate ?? start;
    const time = (date: Date) => calendar.formatTime(date, config());
    if (event.allDay) {
      const last = new Date(Math.max(start.getTime(), end.getTime() - DAY_MS));
      return day(last) === day(start) ? `${day(start)} · ${ui().allDay}` : `${day(start)} – ${day(last)}`;
    }
    if (end.getTime() <= start.getTime()) return `${day(start)} · ${messages().calendarDue({ time: time(start) })}`;
    return day(end) === day(start)
      ? `${day(start)} · ${time(start)}–${time(end)}`
      : `${day(start)} ${time(start)} – ${day(end)} ${time(end)}`;
  };
  const close = (restoreFocus: boolean) => {
    const anchor = props.state?.anchor;
    props.onClose();
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  };

  createEffect(() => {
    const state = props.state;
    if (!element) return;
    if (!state) {
      if (element.matches(":popover-open")) element.hidePopover();
      return;
    }
    if (!element.matches(":popover-open")) element.showPopover();
    const sheet = window.matchMedia(PHONE).matches;
    element.toggleAttribute("data-sheet", sheet);
    queueMicrotask(() => {
      if (!element || props.state !== state) return;
      if (sheet) {
        element.style.removeProperty("left");
        element.style.removeProperty("top");
      } else placeCalendarPopover(state.anchor, element);
      // The panel takes the focus, so the dialog is read first and Tab reaches Close; a focused button would show its tooltip.
      element.querySelector<HTMLElement>(".k2b-calendar-detail")?.focus({ preventScroll: true });
    });
  });

  return (
    <div
      ref={element}
      class="k2b-calendar-popover"
      popover="auto"
      role="dialog"
      aria-label={props.state ? messages().calendarEventDetail({ title: props.state.event.title }) : undefined}
      data-kind="event"
      onToggle={(event) => {
        if (event.newState !== "closed" || !props.state) return;
        close(element?.contains(document.activeElement) === true || document.activeElement === document.body);
      }}
    >
      <Show when={props.state} keyed>
        {(state) => {
          const event = state.event;
          const href = eventHref(props.owner, event);
          const overdue = isOverdue(event, props.owner.calendarNow?.());
          return (
            <div
              class="k2b-calendar-detail"
              tabIndex={-1}
              data-color={event.colorHex ? undefined : (event.color ?? "blue")}
              style={event.colorHex ? { "--k2b-calendar-accent": event.colorHex } : undefined}
            >
              <header class="k2b-calendar-detail__head">
                <Show when={event.icon}>
                  {(icon) => (
                    <span class="k2b-calendar-detail__icon" aria-hidden="true">
                      <i class={icon()} />
                    </span>
                  )}
                </Show>
                <h2 class="k2b-calendar-detail__title" data-done={event.checked === true ? "true" : undefined}>
                  {event.title}
                </h2>
                <IconButton label={ui().close} variant="ghost" size="sm" onClick={() => close(true)}>
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </header>
              <p class="k2b-calendar-detail__row" data-tone={overdue ? "danger" : undefined}>
                <i class={overdue ? "ti ti-alert-circle" : "ti ti-clock"} aria-hidden="true" />
                <span>{overdue ? `${messages().calendarOverdue} · ${when(event)}` : when(event)}</span>
              </p>
              <Show when={event.checked === true}>
                <p class="k2b-calendar-detail__row">
                  <i class="ti ti-circle-check" aria-hidden="true" />
                  <span>{messages().calendarDoneState}</span>
                </p>
              </Show>
              <Show when={event.location}>
                <p class="k2b-calendar-detail__row">
                  <i class="ti ti-map-pin" aria-hidden="true" />
                  <span>{event.location}</span>
                </p>
              </Show>
              <Show when={event.calendarName}>
                <p class="k2b-calendar-detail__row">
                  <i class="ti ti-calendar" aria-hidden="true" />
                  <span>{event.calendarName}</span>
                </p>
              </Show>
              <Show when={event.description?.trim()}>
                <p class="k2b-calendar-detail__description">{event.description}</p>
              </Show>
              <Show when={event.attendees?.length}>
                <section class="k2b-calendar-detail__section" aria-label={messages().calendarPeople}>
                  <h3 class="k2b-calendar-detail__label">{messages().calendarPeople}</h3>
                  <ul class="k2b-calendar-detail__people">
                    <For each={event.attendees}>
                      {(person) => (
                        <li>
                          <Avatar name={person.name} src={person.src} size="xs" alt="" />
                          <span>{person.name}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>
              <Show when={event.links?.length}>
                <section class="k2b-calendar-detail__section" aria-label={messages().calendarLinks}>
                  <h3 class="k2b-calendar-detail__label">{messages().calendarLinks}</h3>
                  <div class="k2b-calendar-detail__links">
                    <For each={event.links}>
                      {(link) => (
                        <ButtonLink href={link.href} variant="secondary" size="sm" align="start" class="k2b-calendar-detail__link">
                          <i class={link.icon ?? "ti ti-link"} aria-hidden="true" />
                          {link.label}
                        </ButtonLink>
                      )}
                    </For>
                  </div>
                </section>
              </Show>
              <Show when={href}>
                {(target) => (
                  <footer class="k2b-calendar-detail__foot">
                    <ButtonLink
                      href={target()}
                      variant="primary"
                      size="sm"
                      onClick={(click: MouseEvent) => {
                        if (!props.owner.onNavigateHref || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey) return;
                        click.preventDefault();
                        props.onClose();
                        followCalendarHref(props.owner, target());
                      }}
                    >
                      {messages().calendarOpenEvent}
                    </ButtonLink>
                  </footer>
                )}
              </Show>
            </div>
          );
        }}
      </Show>
    </div>
  );
};
