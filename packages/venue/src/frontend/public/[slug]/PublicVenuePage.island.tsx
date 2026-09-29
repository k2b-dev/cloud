import { timing } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr";
import { query } from "@k2b/stdlib/solid";
import { Paper, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { type PublicStatus, PublicStatusSchema } from "../../../contracts";
import { venueMessages } from "../../../messages";
import { FitBlock } from "../../_components/fit-list";
import PublicFeedbackForm from "../../_components/PublicFeedbackForm.island";
import {
  ExceptionRow,
  groupedOpeningHours,
  HoursRow,
  hasRegularHours,
  OpeningRow,
  PublicPageBody,
  StatusCard,
  VenueIdentity,
  venueToday,
} from "../../_components/public-page-view";
import { PublicRefreshNotice, type RefreshDiagnostics } from "../../public-refresh-notice";
import { type VenuePublicDisplayHeight, venuePublicRefreshBackoffMs } from "../../public-runtime";

/**
 * The monitor: one screen without scrolling, always dark. Wide screens show two columns when the second one has
 * something to show; a screen taller than it is wide, such as a portrait kiosk or a phone, shows one. Lists cut
 * to the space they get and say "+N more" for the rest, and each keeps at least one row. The feedback code shows
 * whenever everything fits with it; otherwise the lists get its room.
 */
function FullDisplay(props: { status: PublicStatus; feedbackQr: string | null } & RefreshDiagnostics) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const status = () => props.status;
  const today = () => venueToday(status().venue.timezone);
  const todayWeekday = () => new Date(`${today()}T12:00:00Z`).getUTCDay();
  const staffedOpenings = () => status().venue.openMode !== "regular";
  const feedbackQr = () => (status().venue.feedbackEnabled ? props.feedbackQr : null);
  const hasSecondColumn = () => status().upcomingExceptions.length > 0 || staffedOpenings() || Boolean(feedbackQr());
  const moreItems = (count: number) => t().moreItems({ count });

  // Whether the feedback code fits: shown and measured in one go, so it never flashes when it does not.
  const [qrFits, setQrFits] = createSignal(true);
  let layout: HTMLDivElement | undefined;
  let frame = 0;
  const placeQr = () => {
    if (!layout) return;
    setQrFits(true);
    if (layout.scrollHeight > layout.clientHeight + 1) setQrFits(false);
  };
  onMount(() => {
    if (!layout || typeof ResizeObserver === "undefined") return;
    // Any block that changes size may change what fits; measuring waits a frame so it never loops within one.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(placeQr);
    });
    observer.observe(layout);
    for (const block of Array.from(layout.querySelectorAll("section"))) observer.observe(block);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    });
  });
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

        {/*
          In portrait the two columns dissolve into one, and every block shares the same height budget. Without
          exceptions, staffed openings, or a feedback code, a wide screen shows one column instead of an empty half.
        */}
        <div
          ref={layout}
          class={`flex min-h-0 flex-1 flex-col gap-4 ${hasSecondColumn() ? "landscape:grid landscape:grid-cols-2" : ""}`}
          data-display-layout=""
        >
          <div class="contents landscape:flex landscape:min-h-0 landscape:flex-1 landscape:flex-col landscape:gap-4">
            <StatusCard status={status()} display />
            <Show when={hasRegularHours(status())}>
              <FitBlock
                title={t().regularHours}
                block="hours"
                items={groupedOpeningHours(status().openingRules)}
                initial={7}
                more={moreItems}
              >
                {(entry) => <HoursRow entry={entry} today={entry.weekday === todayWeekday()} />}
              </FitBlock>
            </Show>
          </div>
          <Show when={hasSecondColumn()}>
            <div class="contents landscape:flex landscape:min-h-0 landscape:flex-col landscape:gap-4">
              <Show when={status().upcomingExceptions.length > 0}>
                <FitBlock title={t().changedHours} block="exceptions" items={status().upcomingExceptions} initial={3} more={moreItems}>
                  {(exception) => <ExceptionRow exception={exception} today={today()} />}
                </FitBlock>
              </Show>
              <Show when={staffedOpenings()}>
                <FitBlock
                  title={t().upcomingStaffedOpenings}
                  block="openings"
                  items={status().upcomingOpenings}
                  initial={5}
                  empty={t().noStaffedOpening}
                  more={moreItems}
                >
                  {(opening) => <OpeningRow opening={opening} timeZone={status().venue.timezone} />}
                </FitBlock>
              </Show>
              <Show when={feedbackQr()}>
                {(svg) => (
                  // Where the lists need its room, such as on a phone, the code gives way to them.
                  <Paper
                    as="section"
                    class={`flex shrink-0 items-center gap-5 p-5 ${qrFits() ? "" : "hidden"}`}
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
          </Show>
        </div>
      </div>
    </main>
  );
}

/** The scrollable page follows the visitor's Cloud theme; {@link PublicPageBody} owns its content and order. */
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
        <PublicPageBody
          status={status()}
          feedback={<PublicFeedbackForm venueId={status().venue.id} accentColor={status().venue.accentColor} />}
        />
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
