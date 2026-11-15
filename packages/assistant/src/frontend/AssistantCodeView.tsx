import { FeatCodeMark } from "@k2b/cloud/code/ui";
import {
  AppOverview,
  Button,
  DotStrip,
  type DotStripTone,
  FilterToggle,
  Paper,
  Placeholder,
  ScrollArea,
  Skeleton,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { nextCodeRun } from "../code-summary";
import { browserCodeInvoke } from "./code-client";
import {
  automationTiming,
  type CodeCardRun,
  type CodeCardStatus,
  type CodeOverviewItem,
  type CodeOverviewPage,
  cardStatus,
  type DayLine,
  type DayMark,
  dayLine,
  loadCodeOverview,
  localDay,
  needsPerson,
  withCardExtras,
} from "./code-overview";
import { assistantMessages } from "./messages";

type Messages = ReturnType<typeof assistantMessages.resolve>["t"];

/** From this many entries, chips filter the cards. */
const FILTER_FROM = 8;
type Filter = "all" | "attention" | "paused";
const FILTER_PARAM = "show";
const readFilter = (): Filter => {
  if (isServer) return "all";
  const value = new URL(window.location.href).searchParams.get(FILTER_PARAM);
  return value === "attention" || value === "paused" ? value : "all";
};
/** The chosen filter lives in the address, so a reload or "Back" shows the same cards. */
const writeFilter = (filter: Filter) => {
  if (isServer) return;
  const url = new URL(window.location.href);
  if (filter === "all") url.searchParams.delete(FILTER_PARAM);
  else url.searchParams.set(FILTER_PARAM, filter);
  window.history.replaceState(window.history.state, "", url);
};

const codeHref = (codeId: string) => `/app/assistant/code/${codeId}`;

const clock = (iso: string, locale: string, timeZone: string) => {
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
};
/** "today, 06:30" for the person's day, else the short weekday and date: "Mo., 16.11." */
const dayOrTime = (iso: string, t: Messages, locale: string, timeZone: string, now: Date) => {
  if (localDay(timeZone, new Date(iso)) === localDay(timeZone, now)) return t.appsTodayAt({ time: clock(iso, locale, timeZone) });
  const options = { weekday: "short", day: "numeric", month: "numeric" } as const;
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
};
/** How long a run has been running: seconds and minutes as a span, longer as its start time. */
const runningFor = (iso: string, locale: string, timeZone: string, now: Date) => {
  const seconds = Math.max(1, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  const unit = (value: number, kind: "second" | "minute") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: kind, unitDisplay: "long" }).format(value);
  if (seconds < 60) return unit(seconds, "second");
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  return clock(iso, locale, timeZone);
};

const runTone = (run: CodeCardRun): DotStripTone =>
  run.state === "succeeded"
    ? "success"
    : run.state === "failed" || run.state === "cancelled"
      ? "danger"
      : run.state === "skipped"
        ? "warning"
        : "running";
const runWord = (state: CodeCardRun["state"], t: Messages) =>
  state === "succeeded"
    ? t.appsRunSucceeded
    : state === "failed" || state === "cancelled"
      ? t.appsRunFailed
      : state === "skipped"
        ? t.appsRunSkipped
        : t.appsRunRunning;

const STATUS: Record<CodeCardStatus, { tone: string; icon: string; word: (t: Messages) => string }> = {
  on: { tone: "success", icon: "ti ti-circle-check", word: (t) => t.appsStateOn },
  running: { tone: "ai", icon: "ti ti-loader-2", word: (t) => t.appsStateRunning },
  failed: { tone: "danger", icon: "ti ti-alert-circle", word: (t) => t.appsStateFailed },
  access_missing: { tone: "warning", icon: "ti ti-lock", word: (t) => t.appsStateAccess },
  paused: { tone: "warning", icon: "ti ti-player-pause", word: (t) => t.appsStatePaused },
  draft: { tone: "neutral", icon: "ti ti-circle-dashed", word: (t) => t.appsStateDraft },
  deleting: { tone: "neutral", icon: "ti ti-trash", word: (t) => t.appsStateDeleting },
};

/** The card's line under the name: when its automation runs, or how many it has. */
const cardSchedule = (item: CodeOverviewItem, t: Messages, locale: string) => {
  const automations = item.automations ?? [];
  if (automations.length > 1) return t.codeAutomationCount({ count: automations.length });
  return automations[0] ? automationTiming(automations[0], locale) : t.codeKind;
};

/** "Last: …": why the last run failed, else its newest confirmed effect, else the newest run itself. */
const cardLast = (item: CodeOverviewItem, status: CodeCardStatus, t: Messages, locale: string, timeZone: string, now: Date) => {
  const extras = item.extras;
  if (status === "failed" && extras?.failure) return t.appsLast({ text: extras.failure });
  const effect = extras?.activity?.recent[0];
  if (effect) return t.appsLast({ text: effect.text });
  const run = extras?.runs?.[0] ?? item.lastRun;
  if (run === undefined) return t.codeRunUnknown;
  if (!run) return t.appsNoRun;
  return t.appsLast({
    text: t.appsLastRun({ state: runWord(run.state, t), when: dayOrTime(run.endedAt ?? run.createdAt, t, locale, timeZone, now) }),
  });
};

/** Bottom right of a card: the next run, how long a run has been going, or when the last run failed. */
const cardWhen = (item: CodeOverviewItem, status: CodeCardStatus, t: Messages, locale: string, timeZone: string, now: Date) => {
  const running = item.extras?.runs?.[0];
  if (status === "running" && running)
    return t.appsSince({ when: runningFor(running.startedAt ?? running.createdAt, locale, timeZone, now) });
  const newest = running ?? item.lastRun ?? null;
  if (status === "failed" && newest) return dayOrTime(newest.endedAt ?? newest.createdAt, t, locale, timeZone, now);
  // "since 29.10.": the day alone, as Bild 27 shows it.
  if (status === "paused" && item.pausedAt)
    return t.appsSince({
      when: new Intl.DateTimeFormat(locale, { timeZone, day: "2-digit", month: "2-digit" }).format(new Date(item.pausedAt)),
    });
  if (status === "on") {
    const next = nextCodeRun(item);
    return next ? t.codeNextRun({ when: dayOrTime(next, t, locale, timeZone, now) }) : "";
  }
  return "";
};

function CodeCard(props: { item: CodeOverviewItem; timeZone: string; now: Date }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const status = () => cardStatus(props.item);
  const shown = () => STATUS[status()];
  // Oldest left, newest right, as on the Code page.
  const runs = () => [...(props.item.extras?.runs ?? [])].reverse();
  const runsLabel = () =>
    t().appsRuns({
      count: runs().length,
      succeeded: runs().filter((run) => run.state === "succeeded").length,
      failed: runs().filter((run) => run.state === "failed" || run.state === "cancelled").length,
    });
  return (
    <Paper as="a" href={codeHref(props.item.id)} interactive class="assistant-apps__card" data-status={status()}>
      <span class="assistant-apps__card-top">
        <span class="assistant-apps__tile" aria-hidden="true">
          <FeatCodeMark variant="glyph" size={16} decorative />
        </span>
        <span class="assistant-apps__card-copy">
          <span class="assistant-apps__card-title">{props.item.title}</span>
          <span class="assistant-apps__card-schedule">{cardSchedule(props.item, t(), locale())}</span>
        </span>
        <Show when={runs().length > 0}>
          <DotStrip variant="bar" dots={runs().map(runTone)} label={runsLabel()} class="assistant-apps__bars" />
        </Show>
      </span>
      <span class="assistant-apps__card-last">
        <i class="ti ti-arrow-forward-up" aria-hidden="true" />
        <Show when={props.item.extras} fallback={<Skeleton class="assistant-apps__card-last-skeleton" />}>
          <span>{cardLast(props.item, status(), t(), locale(), props.timeZone, props.now)}</span>
        </Show>
      </span>
      <span class="assistant-apps__card-foot">
        <span class="assistant-apps__state" data-tone={shown().tone}>
          <i class={shown().icon} aria-hidden="true" />
          {shown().word(t())}
        </span>
        <span class="assistant-apps__card-when">{cardWhen(props.item, status(), t(), locale(), props.timeZone, props.now)}</span>
      </span>
    </Paper>
  );
}

function CardSkeleton() {
  return (
    <div class="k2b-paper assistant-apps__card" aria-hidden="true">
      <span class="assistant-apps__card-top">
        <Skeleton class="assistant-apps__tile" />
        <span class="assistant-apps__card-copy">
          <Skeleton class="h-3.5 w-3/5" />
          <Skeleton class="h-3 w-2/5" />
        </span>
      </span>
      <span class="assistant-apps__card-last">
        <Skeleton class="assistant-apps__card-last-skeleton" />
      </span>
      <span class="assistant-apps__card-foot">
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-3 w-1/4" />
      </span>
    </div>
  );
}

const HOURS = [0, 6, 12, 18, 24];

/** "Today": every listed Code's runs of the person's day on one line, with the counts as a sentence. */
function DayIsland(props: {
  line: DayLine | null | undefined;
  /** The person's day as Core read it; "now" and the time of each mark stand on it. */
  bounds: { from: string; to: string } | null;
  titles: ReadonlyMap<string, string>;
  timeZone: string;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const sentence = (line: DayLine) => t().appsTodaySentence(line);
  const percent = (at: number) => `${(at * 100).toFixed(3)}%`;
  const span = (bounds: { from: string; to: string }) => Date.parse(bounds.to) - Date.parse(bounds.from);
  const markTime = (mark: DayMark) =>
    props.bounds
      ? clock(new Date(Date.parse(props.bounds.from) + mark.at * span(props.bounds)).toISOString(), locale(), props.timeZone)
      : "";
  /** Where "now" stands on the day, from 0 to 1; only a read day has it. */
  const now = () => (props.bounds ? Math.min(1, Math.max(0, (Date.now() - Date.parse(props.bounds.from)) / span(props.bounds))) : null);
  const markState = (mark: DayMark) =>
    mark.state === "succeeded"
      ? t().appsRunSucceeded
      : mark.state === "failed"
        ? t().appsRunFailed
        : mark.state === "skipped"
          ? t().appsRunSkipped
          : mark.state === "running"
            ? t().appsRunRunning
            : t().appsRunPlanned;
  const markHref = (mark: DayMark) =>
    mark.codeId
      ? mark.runId
        ? `${codeHref(mark.codeId)}?tab=runs&run=${encodeURIComponent(mark.runId)}`
        : codeHref(mark.codeId)
      : undefined;
  return (
    <Paper as="section" class="assistant-apps__today" aria-labelledby="assistant-apps-today">
      <p class="assistant-apps__today-head">
        <span id="assistant-apps-today" class="assistant-apps__today-title">
          {t().appsToday}
        </span>
        <Show when={props.line} fallback={<Show when={props.line === undefined}>{<Skeleton class="h-3 w-64" />}</Show>}>
          {(line) => <span class="assistant-apps__today-sentence">{sentence(line())}</span>}
        </Show>
      </p>
      <Show
        when={props.line !== null}
        fallback={
          <p class="assistant-apps__today-failed" role="alert">
            <i class="ti ti-cloud-off" aria-hidden="true" />
            <span>{t().appsDayFailed}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => props.onRetry()}>
              {t().codeViewRetry}
            </Button>
          </p>
        }
      >
        <Show when={props.line?.missing}>
          {(missing) => (
            <p class="assistant-apps__today-failed" role="status">
              <i class="ti ti-cloud-off" aria-hidden="true" />
              <span>{t().appsDayPartial({ count: missing() })}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => props.onRetry()}>
                {t().codeViewRetry}
              </Button>
            </p>
          )}
        </Show>
        <div class="assistant-apps__day" aria-busy={props.line === undefined ? "true" : undefined}>
          <div
            class="assistant-apps__axis"
            role="img"
            aria-label={props.line ? t().appsDayLabel({ sentence: sentence(props.line) }) : t().appsDayMarks}
          >
            <span class="assistant-apps__axis-line">
              <Show when={now()}>{(at) => <i style={{ width: percent(at()) }} />}</Show>
            </span>
            <For each={HOURS}>
              {(hour) => (
                <span class="assistant-apps__hour" style={{ left: percent(hour / 24) }}>
                  {`${String(hour).padStart(2, "0")}:00`}
                </span>
              )}
            </For>
            <Show when={now()}>
              {(at) => (
                <span class="assistant-apps__now" style={{ left: percent(at()) }}>
                  <span>{t().appsDayNow}</span>
                </span>
              )}
            </Show>
          </div>
          <Show when={props.line}>
            {(line) => (
              <ul class="assistant-apps__marks" aria-label={t().appsDayMarks}>
                <For each={line().marks}>
                  {(mark) => {
                    const label = () =>
                      mark.state === "group"
                        ? t().appsGroupMark({ time: markTime(mark), count: mark.count })
                        : t().appsMark({
                            title: (mark.codeId && props.titles.get(mark.codeId)) || t().codeKind,
                            time: markTime(mark),
                            state: markState(mark),
                          });
                    return (
                      <li style={{ left: percent(mark.at) }}>
                        <Show
                          when={markHref(mark)}
                          fallback={
                            <span class="assistant-apps__mark" data-state={mark.state} role="img" aria-label={label()} title={label()} />
                          }
                        >
                          {(href) => (
                            <a class="assistant-apps__mark" data-state={mark.state} href={href()} title={label()}>
                              <span class="sr-only">{label()}</span>
                            </a>
                          )}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            )}
          </Show>
        </div>
        <p class="assistant-apps__legend" aria-hidden="true">
          <span>
            <i class="assistant-apps__mark" data-state="succeeded" />
            {t().appsLegendSucceeded}
          </span>
          <span>
            <i class="assistant-apps__mark" data-state="failed" />
            {t().appsLegendFailed}
          </span>
          <span>
            <i class="assistant-apps__mark" data-state="planned" />
            {t().appsLegendPlanned}
          </span>
        </p>
      </Show>
    </Paper>
  );
}

/**
 * "My apps & automations": only the person's own Code, which runs as them. Code of a place stays at that place.
 * `initial` is the server's first page (null when it failed); without it, the list loads when the view opens. Items
 * without card extras get them in the browser, bounded by the page.
 */
export default function AssistantCodeView(props: {
  userId: string;
  timeZone: string;
  initial?: CodeOverviewPage | null;
  onCreateInChat: () => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal<CodeOverviewPage | null | undefined>(props.initial);
  const [more, setMore] = createSignal<"idle" | "loading" | "failed">("idle");
  const [filter, setFilter] = createSignal<Filter>(readFilter());
  const owner = () => ({ kind: "person" as const, userId: props.userId });
  const now = () => new Date();
  const day = () => ({ day: localDay(props.timeZone, now()), timeZone: props.timeZone });

  const load = async () => {
    setPage(undefined);
    try {
      setPage(await loadCodeOverview(browserCodeInvoke, owner(), { timeZone: props.timeZone, now: now() }));
    } catch {
      setPage(null);
    }
  };
  // Further pages append below; a failed page keeps what is shown and offers the same request again.
  const loadMore = async () => {
    const current = page();
    if (!current?.nextCursor || more() === "loading") return;
    setMore("loading");
    try {
      const next = await loadCodeOverview(browserCodeInvoke, owner(), {
        timeZone: props.timeZone,
        now: now(),
        cursor: current.nextCursor,
      });
      setPage({ items: [...current.items, ...next.items], nextCursor: next.nextCursor });
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };
  /** Reads card extras for the items that have none; `again` first drops those whose day could not be read. */
  const completeExtras = async (again = false) => {
    const current = page();
    if (!current) return;
    const items = again ? current.items.map((item) => (item.extras?.activity ? item : { ...item, extras: undefined })) : current.items;
    if (items.every((item) => item.extras)) return;
    if (again) setPage({ ...current, items });
    const completed = await withCardExtras(browserCodeInvoke, items, day());
    const latest = page();
    if (!latest) return;
    const byId = new Map(completed.map((item) => [item.id, item.extras]));
    setPage({ ...latest, items: latest.items.map((item) => (item.extras ? item : { ...item, extras: byId.get(item.id) })) });
  };
  onMount(() => {
    if (props.initial === undefined) void load();
    else void completeExtras();
  });

  const items = () => page()?.items ?? [];
  const counts = createMemo(() => {
    const statuses = items().map(cardStatus);
    return {
      all: statuses.length,
      attention: statuses.filter(needsPerson).length,
      paused: statuses.filter((status) => status === "paused").length,
    };
  });
  const showsFilters = () => counts().all >= FILTER_FROM;
  const visible = createMemo(() => {
    const chosen = showsFilters() ? filter() : "all";
    if (chosen === "all") return items();
    return items().filter((item) => (chosen === "paused" ? cardStatus(item) === "paused" : needsPerson(cardStatus(item))));
  });
  const choose = (next: Filter) => {
    setFilter(next);
    writeFilter(next);
  };
  /** The day line, undefined while any card still reads its day, null when no Code's day could be read. */
  const line = createMemo<DayLine | null | undefined>(() => {
    if (items().some((item) => !item.extras)) return undefined;
    return dayLine(items());
  });
  const dayBounds = createMemo(() => {
    const timeline = items().find((item) => item.extras?.activity)?.extras?.activity?.timeline;
    return timeline ? { from: timeline.from, to: timeline.to } : null;
  });
  const titles = createMemo(() => new Map(items().map((item) => [item.id, item.title])));

  const createButton = () => (
    <Button type="button" variant="ai" onClick={() => props.onCreateInChat()}>
      <i class="ti ti-sparkles" aria-hidden="true" />
      {t().codeCreateInChat}
    </Button>
  );
  const empty = () => page() !== undefined && page() !== null && items().length === 0;

  return (
    <ScrollArea class="min-h-0 flex-1">
      <section class="assistant-apps" aria-labelledby="assistant-apps-title">
        <header class="assistant-page-head">
          <div class="assistant-page-head__copy">
            <h1 id="assistant-apps-title" class="assistant-page-head__title">
              {t().myCode}
            </h1>
            <p class="assistant-page-head__lead">{t().codeRunsAsYou}</p>
          </div>
          <Show when={!empty()}>{createButton()}</Show>
        </header>
        <Show
          when={page() !== undefined}
          fallback={
            <div class="assistant-apps__body" role="status" aria-busy="true" aria-label={t().codeViewLoading}>
              <DayIsland line={undefined} bounds={null} titles={titles()} timeZone={props.timeZone} onRetry={() => {}} />
              <AppOverview.Cards class="assistant-apps__cards">
                <For each={[0, 1, 2, 3]}>{() => <CardSkeleton />}</For>
              </AppOverview.Cards>
            </div>
          }
        >
          <Show
            when={page()}
            fallback={
              <Placeholder
                state="error"
                variant="panel"
                icon="ti ti-cloud-off"
                title={t().codeLoadFailed}
                description={t().codeLoadFailedHint}
                onRetry={() => void load()}
              />
            }
          >
            {(current) => (
              <Show
                when={current().items.length > 0}
                fallback={
                  <Placeholder
                    variant="panel"
                    icon="ti ti-code"
                    title={t().codeEmpty}
                    description={t().codeEmptyHint}
                    action={createButton()}
                  />
                }
              >
                <div class="assistant-apps__body">
                  <DayIsland
                    line={line()}
                    bounds={dayBounds()}
                    titles={titles()}
                    timeZone={props.timeZone}
                    onRetry={() => void completeExtras(true)}
                  />
                  <Show when={showsFilters()}>
                    <div class="assistant-apps__filters" role="group" aria-label={t().appsFilters}>
                      <FilterToggle
                        icon="ti ti-layout-grid"
                        label={t().appsFilterAll({ count: counts().all })}
                        active={filter() === "all"}
                        onClick={() => choose("all")}
                      />
                      <Show when={counts().attention > 0 || filter() === "attention"}>
                        <FilterToggle
                          icon="ti ti-alert-circle"
                          label={t().appsFilterAttention({ count: counts().attention })}
                          active={filter() === "attention"}
                          onClick={() => choose("attention")}
                        />
                      </Show>
                      <Show when={counts().paused > 0 || filter() === "paused"}>
                        <FilterToggle
                          icon="ti ti-player-pause"
                          label={t().appsFilterPaused({ count: counts().paused })}
                          active={filter() === "paused"}
                          onClick={() => choose("paused")}
                        />
                      </Show>
                    </div>
                  </Show>
                  <Show when={visible().length > 0} fallback={<p class="assistant-apps__quiet">{t().appsFilterEmpty}</p>}>
                    <AppOverview.Cards class="assistant-apps__cards">
                      <For each={visible()}>{(item) => <CodeCard item={item} timeZone={props.timeZone} now={now()} />}</For>
                    </AppOverview.Cards>
                  </Show>
                  <Show when={current().nextCursor}>
                    <div class="assistant-apps__more">
                      <Button type="button" variant="secondary" size="sm" loading={more() === "loading"} onClick={() => void loadMore()}>
                        {t().codeLoadMore}
                      </Button>
                      <Show when={more() === "failed"}>
                        <span role="alert" class="assistant-apps__more-failed">
                          {t().codeLoadMoreFailed}
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <p class="assistant-apps__quiet">
                    <i class="ti ti-info-circle" aria-hidden="true" />
                    <span>{t().codeElsewhere}</span>
                  </p>
                </div>
              </Show>
            )}
          </Show>
        </Show>
      </section>
    </ScrollArea>
  );
}
