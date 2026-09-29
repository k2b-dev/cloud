import { dates } from "@k2b/stdlib";
import { Disclosure, Paper, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { accentTokens } from "../../accent";
import type { PublicException, PublicOpening, PublicStatus } from "../../contracts";
import { type VenueMessages, venueMessages } from "../../messages";
import { formatClockRange, formatDateKey, formatVenueDay, formatVenueTimeRange } from "../../time-format";
import { PublicSectionView } from "./public-section-view";

/** Weekdays in visitor order: Monday first, Sunday last. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * The regular week from Monday to Sunday, one entry per weekday; `windows` is `null` on a day without regular
 * hours, which the page shows as closed. Without any rule there are no regular hours to list at all.
 */
export const groupedOpeningHours = (
  rules: Array<{ weekday: number; startTime: string; endTime: string; note: string | null }>,
): Array<{ weekday: number; windows: string | null }> =>
  rules.length === 0
    ? []
    : WEEK.map((weekday) => {
        const windows = rules
          .filter((rule) => rule.weekday === weekday)
          .map((rule) => `${formatClockRange(rule.startTime, rule.endTime)}${rule.note ? ` (${rule.note})` : ""}`);
        return { weekday, windows: windows.length > 0 ? windows.join(" & ") : null };
      });

/** Today's date key in the Venue's time zone. */
export const venueToday = (timeZone: string): string => dates.formatDateKey(new Date(), { timeZone });

export const hasRegularHours = (status: PublicStatus): boolean => status.venue.openMode !== "staffed" && status.openingRules.length > 0;

/** `Closed · Public holiday` or `Special opening 18:00–23:00 · Long night`. */
const describeException = (exception: PublicException, t: VenueMessages): string =>
  [
    exception.kind === "open" && exception.startTime && exception.endTime
      ? t.specialOpening({ window: formatClockRange(exception.startTime, exception.endTime) })
      : t.closed,
    exception.note,
  ]
    .filter(Boolean)
    .join(" · ");

export function VenueIdentity(props: { status: PublicStatus; display?: boolean }) {
  const status = () => props.status;
  return (
    <div class="flex min-w-0 items-center gap-4" style={accentTokens(status().venue.accentColor)}>
      {status().venue.logoBase64 ? (
        <img
          src={status().venue.logoBase64 ?? undefined}
          alt=""
          class="size-14 shrink-0 rounded-2xl border border-zinc-200 bg-white object-contain p-2 sm:size-16 dark:border-zinc-800"
        />
      ) : (
        <span
          class="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--venue-accent)] text-2xl text-[var(--venue-on-accent)] sm:size-16 sm:text-3xl"
          aria-hidden="true"
        >
          <i class={status().venue.icon || "ti ti-building-carousel"} />
        </span>
      )}
      <div class="min-w-0">
        {/* A long name wraps onto a second line instead of being cut. */}
        <h1
          class={`${props.display ? "text-2xl lg:text-4xl" : "text-2xl sm:text-4xl"} line-clamp-2 break-words font-semibold text-primary`}
        >
          {status().venue.name}
        </h1>
        {status().venue.description && (
          <p class={`mt-1 max-w-3xl text-sm text-secondary ${props.display ? "line-clamp-1" : ""}`}>{status().venue.description}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Open or closed, and the one fact that goes with it: the current window while open, the next opening while
 * closed, or a single sentence when nothing is planned. The weekly hours below carry the rest of today.
 */
export function StatusCard(props: { status: PublicStatus; display?: boolean }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const status = () => props.status;
  const detail = () =>
    status().open
      ? status().activeWindowLabel
      : status().nextOpeningLabel
        ? t().nextOpening({ value: status().nextOpeningLabel! })
        : t().noUpcomingOpening;
  const layout = () => (props.display ? "flex min-h-0 flex-[1_0_auto] flex-col justify-center p-5 lg:p-8" : "p-5 sm:p-6");
  const content = () => (
    <>
      {/* On the accent, text keeps its full contrast color: dimming it would drop light accents below WCAG AA. */}
      <p class={`text-sm font-medium uppercase ${status().open ? "" : "text-secondary"}`}>{t().currentStatus}</p>
      <p class={`${props.display ? "mt-2 text-5xl lg:text-6xl" : "mt-1 text-4xl"} font-semibold`}>
        {status().open ? t().open : t().closed}
      </p>
      <Show when={detail()}>
        {(text) => (
          <p class={`mt-2 flex items-center gap-2 ${props.display ? "text-xl" : "text-base"} ${status().open ? "" : "text-secondary"}`}>
            <i class="ti ti-clock" aria-hidden="true" />
            <span>{text()}</span>
          </p>
        )}
      </Show>
      <Show when={status().spontaneousOpen}>
        <p class="mt-3 text-sm">{t().spontaneousOpen}</p>
      </Show>
    </>
  );
  return (
    <Show
      when={status().open}
      fallback={
        <Paper as="section" class={`${layout()} text-primary`} data-venue-status="closed">
          {content()}
        </Paper>
      }
    >
      <section
        class={`${layout()} rounded-xl bg-[var(--venue-accent)] text-[var(--venue-on-accent)]`}
        style={accentTokens(status().venue.accentColor)}
        data-venue-status="open"
      >
        {content()}
      </section>
    </Show>
  );
}

export function HoursRow(props: { entry: { weekday: number; windows: string | null }; today: boolean }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const weekday = () =>
    new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + props.entry.weekday)));
  return (
    <div
      class={`flex items-start justify-between gap-3 text-sm ${props.today ? "font-semibold text-primary" : ""}`}
      aria-current={props.today ? "date" : undefined}
    >
      <span class={props.today ? "" : "font-medium text-primary"}>{weekday()}</span>
      <span class={`text-right ${props.today ? "" : "text-secondary"}`}>{props.entry.windows ?? t().closed}</span>
    </div>
  );
}

export function ExceptionRow(props: { exception: PublicException; today: string }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <div class="flex items-start justify-between gap-3 text-sm" data-exception={props.exception.kind}>
      <span class="shrink-0 font-medium text-primary">
        {props.exception.date === props.today
          ? t().today
          : formatDateKey(props.exception.date, locale(), { weekday: "short", day: "numeric", month: "short" })}
      </span>
      <span class="text-right text-secondary">{describeException(props.exception, t())}</span>
    </div>
  );
}

export function OpeningRow(props: { opening: PublicOpening; timeZone: string }) {
  const locale = useLocale();
  return (
    <div class="flex items-center justify-between gap-4 text-sm">
      <div class="min-w-0">
        <p class="truncate font-medium text-primary">{props.opening.title}</p>
        <p class="text-xs text-dimmed">{formatVenueDay(props.opening.startsAt, props.timeZone, locale())}</p>
      </div>
      <span class="shrink-0 font-medium text-secondary">
        {formatVenueTimeRange(props.opening.startsAt, props.opening.endsAt, props.timeZone, locale())}
      </span>
    </div>
  );
}

/** The week's regular hours; visitors can fold them away to reach the content below faster. */
function RegularHours(props: { status: PublicStatus }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const today = () => new Date(`${venueToday(props.status.venue.timezone)}T12:00:00Z`).getUTCDay();
  return (
    <Show when={hasRegularHours(props.status)}>
      <Disclosure summary={t().regularHours} icon="ti ti-clock" defaultValue class="public-hours">
        <div class="grid gap-2 pt-1">
          <For each={groupedOpeningHours(props.status.openingRules)}>
            {(entry) => <HoursRow entry={entry} today={entry.weekday === today()} />}
          </For>
        </div>
      </Disclosure>
    </Show>
  );
}

/** Closed days and special openings of the coming weeks, so visitors learn about them before the day. */
function ChangedHours(props: { status: PublicStatus }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <Show when={props.status.upcomingExceptions.length > 0}>
      <Paper as="section" class="grid gap-3 p-4" data-public-block="exceptions">
        <h2 class="text-base font-semibold text-primary">{t().changedHours}</h2>
        <div class="grid gap-2">
          <For each={props.status.upcomingExceptions}>
            {(exception) => <ExceptionRow exception={exception} today={venueToday(props.status.venue.timezone)} />}
          </For>
        </div>
      </Paper>
    </Show>
  );
}

function UpcomingOpenings(props: { status: PublicStatus }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <Show when={props.status.upcomingOpenings.length > 0}>
      <Paper as="section" class="grid gap-3 p-4" data-public-block="openings">
        <h2 class="text-base font-semibold text-primary">{t().upcomingStaffedOpenings}</h2>
        <div class="grid gap-3">
          <For each={props.status.upcomingOpenings}>
            {(opening) => <OpeningRow opening={opening} timeZone={props.status.venue.timezone} />}
          </For>
        </div>
      </Paper>
    </Show>
  );
}

/**
 * The public page's content below the page frame: banner, identity, status, hours, changed hours, staffed
 * openings, sections, and the `feedback` slot. The public page and the workspace preview render this one
 * component, so the preview cannot drift from the page. On a phone, and always in the `preview` layout, it reads
 * top to bottom in that order; the page on a wide screen keeps the facts in a side column next to the content.
 */
export function PublicPageBody(props: {
  status: PublicStatus;
  /** Shown where the feedback form goes while the Venue takes feedback. */
  feedback?: JSX.Element;
  layout?: "page" | "preview";
  /** The preview marks this section, for example the one an old section link named. */
  selectedSectionId?: string | null;
}) {
  const status = () => props.status;
  const page = () => props.layout !== "preview";
  return (
    <>
      {status().venue.bannerBase64 && (
        <img
          src={status().venue.bannerBase64 ?? undefined}
          alt=""
          class={`w-full rounded-2xl object-cover ${page() ? "h-32 sm:h-56" : "h-32"}`}
        />
      )}
      <header>
        <VenueIdentity status={status()} />
      </header>
      <div
        class={`grid gap-4 ${page() ? "lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_auto_1fr]" : ""}`}
        data-public-layout={props.layout ?? "page"}
      >
        <div class={page() ? "lg:col-start-1 lg:row-start-1" : ""} data-public-block="status">
          <StatusCard status={status()} />
        </div>
        <div class={`flex flex-col gap-4 ${page() ? "lg:col-start-2 lg:row-span-2 lg:row-start-1" : ""}`} data-public-block="facts">
          <RegularHours status={status()} />
          <ChangedHours status={status()} />
          <UpcomingOpenings status={status()} />
        </div>
        <div
          class={`flex min-w-0 flex-col gap-4 ${page() ? "lg:col-start-1 lg:row-span-2 lg:row-start-2" : ""}`}
          data-public-block="sections"
        >
          <For each={status().sections}>
            {(section) => (
              <div
                class={`min-w-0 ${props.selectedSectionId === section.id ? "rounded-xl outline-2 outline-offset-4 outline-[var(--k2b-focus-ring)] outline-solid" : ""}`}
                data-public-section={section.id}
                data-selected={props.selectedSectionId === section.id ? "" : undefined}
              >
                {/* The preview also says how many stored links visitors cannot follow. */}
                <PublicSectionView section={section} timeZone={status().venue.timezone} preview={!page()} />
              </div>
            )}
          </For>
        </div>
        <Show when={status().venue.feedbackEnabled && props.feedback}>
          <div class={page() ? "lg:col-start-2 lg:row-start-3" : ""} data-public-block="feedback">
            {props.feedback}
          </div>
        </Show>
      </div>
    </>
  );
}
