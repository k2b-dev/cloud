import { formatCodeDay } from "@k2b/cloud/code/schedule";
import { followCodeRuns } from "@k2b/cloud/ssr/code-live";
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { nextCodeRun } from "../code-summary";
import { automationTiming } from "./automation-timing";
import { browserCodeInvoke } from "./code-client";
import {
  type CodeCardRun,
  type CodeCardStatus,
  type CodeOverviewItem,
  type CodeOverviewPage,
  cardStatus,
  type DayLine,
  dayLine,
  loadCodeCardExtras,
  loadCodeOverview,
  localDay,
  needsPerson,
  withCardExtras,
} from "./code-overview";
import { codeViewMessages } from "./code-view-messages";
import { assistantMessages } from "./messages";

// "My apps & automations" on v1 and v2: one state, one set of words. The views only draw it.

/** The view's own texts over Gustav's shared ones, for one locale. */
export const viewText = (locale: string) => ({ ...assistantMessages.resolve([locale]).t, ...codeViewMessages.resolve([locale]).t });
export type Messages = ReturnType<typeof viewText>;

/** From this many entries, chips filter the list. */
export const FILTER_FROM = 8;
export type Filter = "all" | "attention" | "paused";
const FILTER_PARAM = "show";
const readFilter = (): Filter => {
  if (isServer) return "all";
  const value = new URL(window.location.href).searchParams.get(FILTER_PARAM);
  return value === "attention" || value === "paused" ? value : "all";
};
/** The chosen filter lives in the address, so a reload or "Back" shows the same entries. */
const writeFilter = (filter: Filter) => {
  if (isServer) return;
  const url = new URL(window.location.href);
  if (filter === "all") url.searchParams.delete(FILTER_PARAM);
  else url.searchParams.set(FILTER_PARAM, filter);
  window.history.replaceState(window.history.state, "", url);
};

export const codeHref = (codeId: string) => `/app/assistant/code/${codeId}`;

export const clock = (iso: string, locale: string, timeZone: string) => {
  const options = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
};
/** "today, 06:30" for the person's day, else the day as every Code surface writes it: "Mo, 16.11." */
export const dayOrTime = (iso: string, t: Messages, locale: string, timeZone: string, now: Date) => {
  if (localDay(timeZone, new Date(iso)) === localDay(timeZone, now)) return t.appsTodayAt({ time: clock(iso, locale, timeZone) });
  return formatCodeDay(iso, { locale, timeZone, now });
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

export const runWord = (state: CodeCardRun["state"], t: Messages) =>
  state === "succeeded"
    ? t.appsRunSucceeded
    : state === "failed" || state === "cancelled"
      ? t.appsRunFailed
      : state === "skipped"
        ? t.appsRunSkipped
        : t.appsRunRunning;

/** Each state's tone, Tabler symbol (without its prefix) and word. */
export const STATE: Record<
  CodeCardStatus,
  { tone: "success" | "ai" | "danger" | "warning" | "neutral"; icon: string; word: (t: Messages) => string }
> = {
  on: { tone: "success", icon: "circle-check", word: (t) => t.appsStateOn },
  running: { tone: "ai", icon: "loader-2", word: (t) => t.appsStateRunning },
  chat_missing: { tone: "danger", icon: "alert-circle", word: (t) => t.appsStateChatMissing },
  failed: { tone: "danger", icon: "alert-circle", word: (t) => t.appsStateFailed },
  access_missing: { tone: "warning", icon: "lock", word: (t) => t.appsStateAccess },
  paused: { tone: "warning", icon: "player-pause", word: (t) => t.appsStatePaused },
  draft: { tone: "neutral", icon: "circle-dashed", word: (t) => t.appsStateDraft },
  deleting: { tone: "neutral", icon: "trash", word: (t) => t.appsStateDeleting },
};

const cardSchedule = (item: CodeOverviewItem, t: Messages, locale: string) => {
  const automations = item.automations ?? [];
  if (automations.length > 1) return t.codeAutomationCount({ count: automations.length });
  if (automations[0]) return automationTiming(automations[0], locale);
  // A draft that runs nothing yet: when its newest version would run, in Core's words.
  const proposed = item.proposedTiming ?? [];
  if (proposed.length > 1) return t.codeAutomationCount({ count: proposed.length });
  // A draft without any version yet has no schedule; it says so instead of only "Automation".
  if (item.state === "draft" && item.proposedTiming?.length === 0) return t.appsNoScheduleYet;
  return proposed[0] ?? t.codeKind;
};

/** The line under the name: when its automation runs, or how many it has, and the chat it writes to. */
export const cardDescription = (item: CodeOverviewItem, t: Messages, locale: string) => {
  const schedule = cardSchedule(item, t, locale);
  const chat = item.extras?.chat;
  if (!chat) return schedule;
  return `${schedule} · ${chat.state === "bound" ? t.appsInChat({ title: chat.title }) : t.appsChatMissing}`;
};

/** What happened last: why the last run failed, else its newest confirmed effect, else the newest run itself. */
export const cardLastText = (item: CodeOverviewItem, status: CodeCardStatus, t: Messages, locale: string, timeZone: string, now: Date) => {
  const extras = item.extras;
  if (extras?.chat?.state === "missing")
    return extras.chat.archivedTitle ? t.appsChatArchived({ title: extras.chat.archivedTitle }) : t.appsChatGone;
  if (status === "failed" && extras?.failure) return extras.failure;
  const effect = extras?.activity?.recent[0];
  if (effect) return effect.text;
  const run = extras?.runs?.[0] ?? item.lastRun;
  if (run === undefined) return null;
  if (!run) return t.appsNoRun;
  return t.appsLastRun({ state: runWord(run.state, t), when: dayOrTime(run.endedAt ?? run.createdAt, t, locale, timeZone, now) });
};

/** "Last: …" for a card, where no column head says it already. */
export const cardLast = (item: CodeOverviewItem, status: CodeCardStatus, t: Messages, locale: string, timeZone: string, now: Date) => {
  const text = cardLastText(item, status, t, locale, timeZone, now);
  if (text === null) return t.codeRunUnknown;
  return text === t.appsNoRun ? text : t.appsLast({ text });
};

/** The next run, how long a run has been going, or when the last run failed. */
export const cardWhen = (item: CodeOverviewItem, status: CodeCardStatus, t: Messages, locale: string, timeZone: string, now: Date) => {
  const running = item.extras?.runs?.[0];
  if (status === "running" && running)
    return t.appsSince({ when: runningFor(running.startedAt ?? running.createdAt, locale, timeZone, now) });
  const newest = running ?? item.lastRun ?? null;
  if ((status === "failed" || status === "chat_missing") && newest)
    return dayOrTime(newest.endedAt ?? newest.createdAt, t, locale, timeZone, now);
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

/** What the view is given: the person, their time zone, and the server's first page (null when it failed). */
export type CodeOverviewProps = {
  userId: string;
  timeZone: string;
  initial?: CodeOverviewPage | null;
  onCreateInChat: () => void;
};

/**
 * The person's own Code with its card extras, the filter in the address, and runs that move live. `initial` is the
 * server's first page; without it, the list loads when the view opens. Items without card extras get them in the
 * browser, bounded by the page.
 */
/**
 * `filterFrom`: from how many entries the chosen filter applies. v1 shows its chips only from `FILTER_FROM`; v2 always
 * shows its exceptions as chips, so every chip filters (`0`).
 */
export const createCodeOverview = (props: Omit<CodeOverviewProps, "onCreateInChat">, filterFrom = FILTER_FROM) => {
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
  // Runs move live (6a): an entry says "Running" when its run starts and reads its last result once it ends. One
  // subscription per listed Code on the shared live socket; nothing polls (#59).
  const followed = new Map<string, () => void>();
  const changeRun = (codeId: string, event: { runId: string; state: CodeCardRun["state"]; at: string }) => {
    const current = page();
    if (!current) return;
    setPage({
      ...current,
      items: current.items.map((item) => {
        if (item.id !== codeId || !item.extras) return item;
        const runs = item.extras.runs ?? [];
        const known = runs.some((run) => run.id === event.runId);
        const next = known
          ? runs.map((run) => (run.id === event.runId ? { ...run, state: event.state } : run))
          : [{ id: event.runId, state: event.state, createdAt: event.at, startedAt: event.at, endedAt: null }, ...runs];
        return { ...item, extras: { ...item.extras, runs: next } };
      }),
    });
    if (event.state === "succeeded" || event.state === "failed" || event.state === "skipped") {
      void loadCodeCardExtras(browserCodeInvoke, codeId, day()).then((extras) => {
        const latest = page();
        if (latest) setPage({ ...latest, items: latest.items.map((item) => (item.id === codeId ? { ...item, extras } : item)) });
      });
    }
  };
  createEffect(() => {
    for (const item of page()?.items ?? []) {
      if (followed.has(item.id) || item.state !== "active") continue;
      followed.set(
        item.id,
        followCodeRuns(item.id, (event) => changeRun(item.id, event)),
      );
    }
  });
  onCleanup(() => {
    for (const stop of followed.values()) stop();
  });

  const items = () => page()?.items ?? [];
  const counts = createMemo(() => {
    const statuses = items().map(cardStatus);
    return {
      all: statuses.length,
      attention: statuses.filter(needsPerson).length,
      paused: statuses.filter((status) => status === "paused").length,
      running: statuses.filter((status) => status === "running").length,
    };
  });
  const showsFilters = () => counts().all >= filterFrom;
  const visible = createMemo(() => {
    const chosen = showsFilters() ? filter() : "all";
    if (chosen === "all") return items();
    return items().filter((item) => (chosen === "paused" ? cardStatus(item) === "paused" : needsPerson(cardStatus(item))));
  });
  const choose = (next: Filter) => {
    setFilter(next);
    writeFilter(next);
  };
  /** The day line, undefined while any entry still reads its day, null when no Code's day could be read. */
  const line = createMemo<DayLine | null | undefined>(() => {
    if (items().some((item) => !item.extras)) return undefined;
    return dayLine(items());
  });
  const dayBounds = createMemo(() => {
    const timeline = items().find((item) => item.extras?.activity)?.extras?.activity?.timeline;
    return timeline ? { from: timeline.from, to: timeline.to } : null;
  });
  const titles = createMemo(() => new Map(items().map((item) => [item.id, item.title])));
  const empty = () => page() !== undefined && page() !== null && items().length === 0;

  return {
    page,
    more,
    filter,
    now,
    load,
    loadMore,
    completeExtras,
    items,
    counts,
    showsFilters,
    visible,
    choose,
    line,
    dayBounds,
    titles,
    empty,
  };
};
