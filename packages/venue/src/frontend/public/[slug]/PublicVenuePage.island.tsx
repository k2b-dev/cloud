import { dates, timing } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr";
import { query } from "@k2b/stdlib/solid";
import { Disclosure, Paper, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { accentTokens } from "../../../accent";
import { apiClient } from "../../../api/client";
import { type PublicException, type PublicOpening, type PublicStatus, PublicStatusSchema } from "../../../contracts";
import { type VenueMessages, venueMessages } from "../../../messages";
import { formatDateKey } from "../../../time-format";
import { FitList } from "../../_components/fit-list";
import PublicFeedbackForm from "../../_components/PublicFeedbackForm.island";
import { PublicSectionView } from "../../_components/public-section-view";
import { PublicRefreshNotice, type RefreshDiagnostics } from "../../public-refresh-notice";
import { type VenuePublicDisplayHeight, venuePublicRefreshBackoffMs } from "../../public-runtime";

/** Weekdays in visitor order: Monday first, Sunday last. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const groupedOpeningHours = (
  rules: Array<{ weekday: number; startTime: string; endTime: string; note: string | null }>,
): Array<{ weekday: number; windows: string }> =>
  WEEK.map((weekday) => {
    const windows = rules
      .filter((rule) => rule.weekday === weekday)
      .map((rule) => `${rule.startTime}-${rule.endTime}${rule.note ? ` (${rule.note})` : ""}`);
    return { weekday, windows: windows.join(" & ") };
  }).filter((entry) => entry.windows);

/** Today's date key in the Venue's time zone. */
const venueToday = (timeZone: string): string => dates.formatDateKey(new Date(), { timeZone });

const hasRegularHours = (status: PublicStatus): boolean =>
  status.venue.openMode !== "staffed" && groupedOpeningHours(status.openingRules).length > 0;

const formatOpeningDate = (opening: PublicOpening, timezone: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: "short", day: "2-digit", month: "short" }).format(
    new Date(opening.startsAt),
  );

const formatOpeningTime = (opening: PublicOpening, timezone: string, locale: string): string => {
  const formatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${formatter.format(new Date(opening.startsAt))}-${formatter.format(new Date(opening.endsAt))}`;
};

/** `Closed · Public holiday` or `Special opening 18:00–23:00 · Long night`. */
const describeException = (exception: PublicException, t: VenueMessages): string =>
  [
    exception.kind === "open" && exception.startTime && exception.endTime
      ? t.specialOpening({ window: `${exception.startTime}–${exception.endTime}` })
      : t.closed,
    exception.note,
  ]
    .filter(Boolean)
    .join(" · ");

function VenueIdentity(props: { status: PublicStatus; display?: boolean }) {
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
function StatusCard(props: { status: PublicStatus; display?: boolean }) {
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

function HoursRow(props: { entry: { weekday: number; windows: string }; today: boolean }) {
  const locale = useLocale();
  const weekday = () =>
    new Intl.DateTimeFormat(locale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + props.entry.weekday)));
  return (
    <div
      class={`flex items-start justify-between gap-3 text-sm ${props.today ? "font-semibold text-primary" : ""}`}
      aria-current={props.today ? "date" : undefined}
    >
      <span class={props.today ? "" : "font-medium text-primary"}>{weekday()}</span>
      <span class={`text-right ${props.today ? "" : "text-secondary"}`}>{props.entry.windows}</span>
    </div>
  );
}

function ExceptionRow(props: { exception: PublicException; today: string }) {
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

function OpeningRow(props: { opening: PublicOpening; timeZone: string }) {
  const locale = useLocale();
  return (
    <div class="flex items-center justify-between gap-4 text-sm">
      <div class="min-w-0">
        <p class="truncate font-medium text-primary">{props.opening.title}</p>
        <p class="text-xs text-dimmed">{formatOpeningDate(props.opening, props.timeZone, locale())}</p>
      </div>
      <span class="shrink-0 font-medium text-secondary">{formatOpeningTime(props.opening, props.timeZone, locale())}</span>
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

/** A monitor block whose rows are cut to its height, with a count of what it leaves out. */
function DisplayBlock<T>(props: {
  title: string;
  items: readonly T[];
  initial: number;
  empty?: string;
  block: string;
  children: (item: T) => JSX.Element;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    // Every block keeps at least its heading and one row, so a short screen still says what it leaves out.
    <Paper as="section" class="flex min-h-28 flex-[0_1_auto] flex-col gap-2 p-4 lg:gap-3 lg:p-5" data-public-block={props.block}>
      <h2 class="shrink-0 text-base font-semibold text-primary lg:text-lg">{props.title}</h2>
      <Show when={props.items.length > 0} fallback={<p class="text-sm text-secondary">{props.empty}</p>}>
        <FitList items={props.items} initial={props.initial} more={(count) => t().moreItems({ count })}>
          {props.children}
        </FitList>
      </Show>
    </Paper>
  );
}

/**
 * The monitor: one screen without scrolling, always dark. Wide screens show two columns; a screen taller than
 * it is wide, such as a portrait kiosk or a phone, shows one. Lists cut to the space they get and say
 * "+N more" for the rest.
 */
function FullDisplay(props: { status: PublicStatus; feedbackQr: string | null } & RefreshDiagnostics) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const status = () => props.status;
  const today = () => venueToday(status().venue.timezone);
  const todayWeekday = () => new Date(`${today()}T12:00:00Z`).getUTCDay();
  const staffedOpenings = () => status().venue.openMode !== "regular";
  return (
    <main
      class="relative h-dvh overflow-hidden text-primary"
      data-live-refresh={props.refreshEnabled ? "enabled" : "disabled"}
      data-last-refresh-at={props.refreshedAt ?? undefined}
      data-refresh-error={props.refreshError ?? undefined}
    >
      <PublicRefreshNotice {...props} display />
      {status().venue.bannerBase64 && (
        <img src={status().venue.bannerBase64 ?? undefined} alt="" class="absolute inset-0 size-full object-cover opacity-20" />
      )}
      <div class="relative flex h-full min-h-0 flex-col gap-4 p-4 sm:p-5 lg:p-8">
        <header class="shrink-0">
          <VenueIdentity status={status()} display />
        </header>

        {/* In portrait the two columns dissolve into one, and every block shares the same height budget. */}
        <div class="flex min-h-0 flex-1 flex-col gap-4 landscape:grid landscape:grid-cols-2" data-display-layout="">
          <div class="contents landscape:flex landscape:min-h-0 landscape:flex-col landscape:gap-4">
            <StatusCard status={status()} display />
            <Show when={hasRegularHours(status())}>
              <DisplayBlock title={t().regularHours} block="hours" items={groupedOpeningHours(status().openingRules)} initial={7}>
                {(entry) => <HoursRow entry={entry} today={entry.weekday === todayWeekday()} />}
              </DisplayBlock>
            </Show>
          </div>
          <div class="contents landscape:flex landscape:min-h-0 landscape:flex-col landscape:gap-4">
            <Show when={status().upcomingExceptions.length > 0}>
              <DisplayBlock title={t().changedHours} block="exceptions" items={status().upcomingExceptions} initial={3}>
                {(exception) => <ExceptionRow exception={exception} today={today()} />}
              </DisplayBlock>
            </Show>
            <Show when={staffedOpenings()}>
              <DisplayBlock
                title={t().upcomingStaffedOpenings}
                block="openings"
                items={status().upcomingOpenings}
                initial={5}
                empty={t().noStaffedOpening}
              >
                {(opening) => <OpeningRow opening={opening} timeZone={status().venue.timezone} />}
              </DisplayBlock>
            </Show>
            <Show when={status().venue.feedbackEnabled && props.feedbackQr}>
              {(svg) => (
                // On a short portrait screen, such as a phone, the lists need the room more than a code to scan.
                <Paper
                  as="section"
                  class="flex shrink-0 items-center gap-5 p-5 [@media(orientation:portrait)_and_(max-height:900px)]:hidden"
                  data-public-block="feedback-qr"
                >
                  {/* A QR code needs a light background to scan, also on the dark monitor. */}
                  <div class="size-28 shrink-0 rounded-lg bg-white p-2 lg:size-36 [&_svg]:block [&_svg]:size-full" innerHTML={svg()} />
                  <div class="min-w-0">
                    <p class="text-lg font-semibold">{t().shareFeedback}</p>
                    <p class="mt-1 text-sm leading-relaxed text-secondary">{t().scanFeedback}</p>
                  </div>
                </Paper>
              )}
            </Show>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The scrollable page follows the visitor's Cloud theme. On a phone it reads top to bottom as status, this
 * week's hours, changed hours, staffed openings, content, and feedback; wide screens keep the facts in a side
 * column next to the content.
 */
function ScrollablePage(props: { status: PublicStatus } & RefreshDiagnostics) {
  const status = () => props.status;
  return (
    <main
      class="min-h-dvh text-primary"
      data-live-refresh={props.refreshEnabled ? "enabled" : "disabled"}
      data-last-refresh-at={props.refreshedAt ?? undefined}
      data-refresh-error={props.refreshError ?? undefined}
    >
      <PublicRefreshNotice {...props} />
      <div class="mx-auto flex max-w-6xl flex-col gap-4 p-4 sm:gap-6 sm:p-6">
        {status().venue.bannerBase64 && (
          <img src={status().venue.bannerBase64 ?? undefined} alt="" class="h-32 w-full rounded-2xl object-cover sm:h-56" />
        )}
        <header>
          <VenueIdentity status={status()} />
        </header>
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_auto_1fr]" data-public-layout="">
          <div class="lg:col-start-1 lg:row-start-1" data-public-block="status">
            <StatusCard status={status()} />
          </div>
          <div class="flex flex-col gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1" data-public-block="facts">
            <RegularHours status={status()} />
            <ChangedHours status={status()} />
            <UpcomingOpenings status={status()} />
          </div>
          <div class="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-2" data-public-block="sections">
            <For each={status().sections}>{(section) => <PublicSectionView section={section} timeZone={status().venue.timezone} />}</For>
          </div>
          <Show when={status().venue.feedbackEnabled}>
            <div class="lg:col-start-2 lg:row-start-3" data-public-block="feedback">
              <PublicFeedbackForm venueId={status().venue.id} accentColor={status().venue.accentColor} />
            </div>
          </Show>
        </div>
      </div>
    </main>
  );
}

function UnavailablePage(props: RefreshDiagnostics) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  return (
    <main
      class="min-h-dvh text-primary"
      data-live-refresh={props.refreshEnabled ? "enabled" : "disabled"}
      data-last-refresh-at={props.refreshedAt ?? undefined}
      data-refresh-error={props.refreshError ?? undefined}
    >
      <PublicRefreshNotice {...props} />
      <div class="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center p-6 text-center">
        <i class="ti ti-building-store-off mb-4 text-5xl text-dimmed" aria-hidden="true" />
        <h1 class="text-2xl font-semibold">{t().publicUnavailable}</h1>
        <p class="mt-2 text-sm text-secondary">{t().publicUnavailableDescription}</p>
        {/* The same link for every visitor and every unknown or switched-off venue, so the page reveals nothing. */}
        <a
          href="/app/venue"
          class="mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-primary no-underline hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          <i class="ti ti-building-carousel" aria-hidden="true" />
          {t().openInVenues}
        </a>
      </div>
    </main>
  );
}

const readResponseError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

const PUBLIC_REFRESH_REQUEST_TIMEOUT_MS = 10_000;

const fetchPublicStatus = async (
  venueId: string,
  parentSignal: AbortSignal,
  messages: { refreshVenueFailed: string; refreshVenueTimedOut: string },
): Promise<PublicStatus | null> => {
  const request = new AbortController();
  let timedOut = false;
  const abort = () => request.abort();
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, PUBLIC_REFRESH_REQUEST_TIMEOUT_MS);

  try {
    const response = await apiClient.public[":id"].status.$get(
      { param: { id: venueId } },
      { init: { cache: "no-store", signal: request.signal } },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await readResponseError(response, messages.refreshVenueFailed));
    return PublicStatusSchema.parse(await response.json());
  } catch (error) {
    if (timedOut) throw new Error(messages.refreshVenueTimedOut);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
};

type PublicVenuePageProps = {
  venueId: string;
  initialStatus: PublicStatus | null;
  displayHeight: VenuePublicDisplayHeight;
  feedbackUrl: string;
  refresh: boolean;
};

export default function PublicVenuePage(props: PublicVenuePageProps) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [refreshedAt, setRefreshedAt] = createSignal<string | null>(null);
  const [visible, setVisible] = createSignal(true);
  let disposed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let visibilityHandler: (() => void) | undefined;

  const statusQuery = query.create({
    source: () => props.venueId,
    initial: { source: props.venueId, data: props.initialStatus },
    enabled: () => props.refresh && visible(),
    load: (venueId, { abortSignal }) => fetchPublicStatus(venueId, abortSignal, t()),
  });

  const nextDelay = () => Math.max(1_000, Math.min(60_000, timing.jitter(venuePublicRefreshBackoffMs(failures), 350)));
  const schedule = (delay: number) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  };
  const run = async () => {
    if (disposed) return;
    if (!visible()) {
      schedule(venuePublicRefreshBackoffMs(0));
      return;
    }
    if (statusQuery.refreshing() || statusQuery.loading()) return;
    await statusQuery.refresh();
    if (statusQuery.error()) {
      failures += 1;
      console.warn("Venue public page refresh failed", statusQuery.error());
    } else {
      failures = 0;
      setRefreshedAt(new Date().toISOString());
    }
    schedule(nextDelay());
  };
  const retryRefresh = () => {
    failures = 0;
    schedule(0);
  };

  onMount(() => {
    if (!props.refresh) return;
    setVisible(!document.hidden);
    visibilityHandler = () => {
      setVisible(!document.hidden);
      if (!document.hidden) schedule(0);
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    schedule(venuePublicRefreshBackoffMs(0));
  });

  onCleanup(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
    if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
  });

  const feedbackQr = () =>
    statusQuery.data()?.venue.feedbackEnabled
      ? qr.toSvg(props.feedbackUrl, { correctionLevel: "M", on: "#18181b", off: "transparent" })
      : null;

  return (
    <Show
      when={statusQuery.data()}
      fallback={
        <UnavailablePage
          refreshEnabled={props.refresh}
          refreshedAt={refreshedAt()}
          refreshError={statusQuery.error()?.message ?? null}
          refreshing={statusQuery.refreshing()}
          retryRefresh={retryRefresh}
        />
      }
    >
      {(current) =>
        props.displayHeight === "full" ? (
          <FullDisplay
            status={current()}
            feedbackQr={feedbackQr()}
            refreshEnabled={props.refresh}
            refreshedAt={refreshedAt()}
            refreshError={statusQuery.error()?.message ?? null}
            refreshing={statusQuery.refreshing()}
            retryRefresh={retryRefresh}
          />
        ) : (
          <ScrollablePage
            status={current()}
            refreshEnabled={props.refresh}
            refreshedAt={refreshedAt()}
            refreshError={statusQuery.error()?.message ?? null}
            refreshing={statusQuery.refreshing()}
            retryRefresh={retryRefresh}
          />
        )
      }
    </Show>
  );
}
