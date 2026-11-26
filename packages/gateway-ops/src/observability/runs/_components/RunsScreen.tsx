import { api } from "@k2b/cloud/browser";
import type { TraceSuccessMinutes } from "@k2b/cloud/services";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Chart, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Canvas,
  Chip,
  Empty,
  Failed,
  FilterBar,
  Icon,
  Input,
  ListOrder,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Section,
  StatusRow,
  Table,
  Tabs,
  Text,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import RunNow from "../../sync/_components/RunNow";
import type { SyncScheduleRow } from "../../sync/service";
import type { RunsApi } from "../api";
import { runsMessages } from "../messages";
import {
  kindsOf,
  parseRunsAddress,
  RUNS_PAGE_MAX,
  RUNS_PATH,
  RUNS_PER_PAGE,
  type RunKind,
  type RunRef,
  type RunStatus,
  type RunsState,
  type RunsTab,
  runsHref,
  runsQuery,
} from "../query";
import type { JobTimeline, RunFigures, RunRecord, RunRow, RunsList, RunsPart } from "../service";
import { runDurationFormatter } from "./duration";
import RunRecordPane from "./RunRecordPane";

export type RunsScreenProps = {
  nav: NavProps;
  apps: { id: string; label: string; icon?: string }[];
  timeZone: string;
  /** The server's clock when it read the list, for "running for …" and the schedules' next run. */
  now: string;
  state: RunsState;
  page: number;
  run: RunRef | null;
  tab: RunsTab;
  ignored: string | null;
  /** Names of the workflow definition and parent run the address names, read by the server for the first picture. */
  names?: { workflow?: LookupItem[]; parent?: LookupItem[] };
  /** The runs view: its parts, key figures and job lanes; null in the other views. */
  list: RunsList | null;
  /** The successful job runs per minute, in the minutes view. */
  minutes: { minutes: TraceSuccessMinutes | null; error: string | null } | null;
  record: { record: RunRecord | null; error: string | null } | null;
  schedules: { schedules: SyncScheduleRow[]; warnings: string[]; error: string | null } | null;
};

const client = api.create<RunsApi>({ baseUrl: "/api/gateway/runs" });

const STATUS_CHIP: Partial<Record<RunStatus, "ok" | "warn" | "bad">> = { failed: "bad", succeeded: "ok" };
/** Each state has its colour (where it means something), its symbol and its word. */
const STATUS_ICON: Record<RunStatus, string> = {
  failed: "alert-circle",
  running: "player-play",
  waiting: "clock",
  succeeded: "check",
  canceled: "ban",
};

/** Runs on v2: one list of every kind of run, each kind paging on its own, and the schedules that start jobs. */
export default function RunsScreen(props: RunsScreenProps) {
  const locale = useLocale();
  const t = () => runsMessages.resolve([locale()]).t;
  const query = createMemo(() =>
    runsQuery(locale(), props.apps, props.state.filters.app, async (text, context) => {
      const time = state().filters.time;
      const response = await client.workflows.$get(
        {
          query: {
            q: text,
            limit: String(context.limit),
            time: time.kind === "preset" ? time.preset : "last-24h",
            ...(state().filters.app ? { app: state().filters.app } : {}),
          },
        },
        { init: { signal: context.signal } },
      );
      if (!response.ok) throw new Error(response.statusText);
      return response.json();
    }),
  );
  const [state, setState] = createSignal<RunsState>(props.state);
  const [parts, setParts] = createSignal<RunsPart[]>(props.list?.parts ?? []);
  const [figures, setFigures] = createSignal<RunFigures>(props.list?.figures ?? {});
  const [timeline, setTimeline] = createSignal<JobTimeline | null>(props.list?.timeline ?? null);
  const [minutes, setMinutes] = createSignal(props.minutes);
  // a new filter starts the list at its first page; the pager follows what was loaded, not the first address
  const [page, setPage] = createSignal(props.page);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const kindLabel = (kind: RunKind, plural = true) =>
    plural
      ? { job: t().jobs, workflow: t().workflows, delivery: t().deliveries, deadLetter: t().deadLetters }[kind]
      : { job: t().job, workflow: t().workflow, delivery: t().delivery, deadLetter: t().deadLetter }[kind];
  const statusLabel = (status: RunStatus) =>
    ({ failed: t().failed, running: t().running, waiting: t().waiting, succeeded: t().succeeded, canceled: t().canceled })[status];
  const clock = createMemo(
    () =>
      new Intl.DateTimeFormat(locale(), {
        timeZone: props.timeZone,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
  );
  const at = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : clock().format(date);
  };
  const duration = createMemo(() => runDurationFormatter(locale()));

  const kinds = () => kindsOf(state());
  const single = () => kinds().length === 1;
  const rows = createMemo(() => parts().flatMap((part) => part.rows));

  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  /** Loads the list for a state through the API; the rows stay until the new ones come, a newer change aborts this one. */
  const load = async (next: RunsState) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setLoading(true);
    try {
      const params = Object.fromEntries(query().serialize(next)) as Record<string, string>;
      // the page the list shows: 1 after a new filter, the address's own after a history step
      if (page() > 1) params.page = String(page());
      if (props.tab === "minutes") {
        const response = await client.minutes.$get({ query: params }, { init: { signal: current.signal } });
        if (!response.ok) throw new Error(response.statusText);
        const body = await response.json();
        if (current.signal.aborted) return;
        setMinutes({ minutes: body.minutes, error: null });
      } else {
        const response = await client.index.$get({ query: params }, { init: { signal: current.signal } });
        if (!response.ok) throw new Error(response.statusText);
        const body = await response.json();
        if (current.signal.aborted) return;
        setParts(body.parts);
        setFigures(body.figures);
        setTimeline(body.timeline);
      }
      setFailed(false);
    } catch {
      if (!current.signal.aborted) setFailed(true);
    } finally {
      if (controller === current) setLoading(false);
    }
  };

  /** A new state from the bar, the search or the order: the list starts at its first page again. */
  /** The page of the address after a history step (back or forward), read before the bar reports the step. */
  let restoring: number | undefined;
  onMount(() => {
    // capture: this runs before the bar's own listener reports the step through `change`
    const step = () => {
      restoring = parseRunsAddress(query(), new URLSearchParams(location.search)).page;
    };
    addEventListener("popstate", step, { capture: true });
    onCleanup(() => removeEventListener("popstate", step, { capture: true }));
  });

  /**
   * A new state from the bar, the search or the order starts the list at its first page. A history step restores the
   * address as it was, its page included, and writes no history.
   */
  const change = (next: RunsState) => {
    setState(next);
    const restored = restoring;
    restoring = undefined;
    if (restored !== undefined) {
      setPage(restored);
      void load(next);
      return;
    }
    setPage(1);
    if (!isServer) {
      const params = new URLSearchParams(location.search);
      if (params.has("page")) {
        params.delete("page");
        history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
      }
    }
    void load(next);
  };
  const search = (text: string) => {
    const next = { ...state(), search: text.trim() || undefined };
    const params = query().serialize(next, location.search);
    params.delete("page");
    history.pushState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    change(next);
  };

  const base = () => query().reset();
  const changed = () => query().serialize(state()).toString() !== query().serialize(base()).toString();
  const onlyKind = (kind: RunKind): RunsState => ({ ...state(), filters: { ...state().filters, kind: [kind] } });
  const failedView = (): RunsState => ({ ...query().reset(), filters: { ...query().reset().filters, status: "failed" } });
  const href = (extra: { page?: number; run?: RunRef | null } = {}) =>
    runsHref(query(), state(), {
      page: extra.page ?? page(),
      run: extra.run === undefined ? props.run : extra.run,
      tab: props.tab === "runs" ? undefined : props.tab,
    });
  const openOf = (row: RunRow) => ({ href: row.recordHref ?? href({ run: row.ref }) });

  // What the filters do not apply to, said once above the list.
  const notes = createMemo(() => {
    const result: string[] = [];
    const shown = kinds();
    if (state().search && shown.includes("workflow")) result.push(t().searchNotFor({ kinds: t().workflows }));
    if (
      shown.includes("deadLetter") &&
      (() => {
        const time = state().filters.time;
        return time.kind === "preset" && time.preset !== "last-24h";
      })()
    )
      result.push(t().timeNotFor({ kinds: t().deadLetters }));
    return result;
  });

  const total = () => {
    const counted = parts().every((part) => part.total !== null);
    return counted ? parts().reduce((sum, part) => sum + (part.total ?? 0), 0) : null;
  };
  const lead = () => {
    const all = total();
    if (single() && all !== null) return t().runsOf({ count: number(rows().length), total: number(all) });
    const shown = rows().length;
    const more = all === null || parts().some((part) => part.more);
    // "1+" is more than one: the plural
    return t().runsCount({ count: more ? `${number(shown)}+` : number(shown), n: more ? shown + 1 : shown });
  };
  const singlePart = () => (single() ? parts()[0] : undefined);
  const pages = () => {
    const part = singlePart();
    if (!part) return 1;
    if (part.total !== null) return Math.min(RUNS_PAGE_MAX, Math.max(1, Math.ceil(part.total / RUNS_PER_PAGE)));
    return part.more ? page() + 1 : page();
  };

  const appLabel = (appId: string | null) => (appId ? (props.apps.find((app) => app.id === appId)?.label ?? appId) : "");
  /** The app a run belongs to, with the app's own symbol. */
  const appChip = (appId: string | null) => {
    if (!appId) return "—";
    const app = props.apps.find((candidate) => candidate.id === appId);
    // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut; the symbol
    // stands before the name, which a narrow column cuts with "…" (a chip may not cut its word).
    return (
      <>
        <Icon name={app?.icon ?? "apps"} /> {app?.label ?? appId}
      </>
    );
  };
  const statusChip = (status: RunStatus) => {
    const tone = STATUS_CHIP[status];
    // a toned state's dot is its sign; a state without a tone (running, waiting, canceled) carries its symbol
    return tone ? <Chip status={tone}>{statusLabel(status)}</Chip> : <Chip icon={STATUS_ICON[status]}>{statusLabel(status)}</Chip>;
  };

  const percent = (value: number) => new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(value);
  /**
   * What matters in the window, before the list: beside other kinds two figures each for jobs and deliveries, alone
   * four for the one kind. Workflow runs and dead letters have their own pages' figures.
   */
  const cells = createMemo((): KeyCell[] => {
    const { job, delivery } = figures();
    const jobCells = (all: boolean): KeyCell[] =>
      job
        ? [
            { icon: "check", label: t().jobsSucceeded, value: number(job.succeeded), meta: t().countedPerMinute },
            {
              icon: "alert-circle",
              label: t().jobsFailed,
              value: number(job.failed),
              tone: job.failed > 0 ? "bad" : undefined,
              meta: job.stuck > 0 ? t().stuckCount({ count: number(job.stuck) }) : t().noneStuck,
            },
            ...(all
              ? [
                  { icon: "player-play", label: t().jobsRunning, value: number(job.running) },
                  {
                    icon: "hourglass",
                    label: t().jobsDuration,
                    value: job.p95DurationMs === null ? "—" : (duration()(job.p95DurationMs) ?? "—"),
                    meta: t().withoutOutliers,
                  },
                ]
              : []),
          ]
        : [];
    const deliveryCells = (all: boolean): KeyCell[] =>
      delivery
        ? [
            {
              icon: "send",
              label: t().deliveredShare,
              value: delivery.total ? percent(delivery.delivered / delivery.total) : "—",
              meta: t().deliveredOf({ count: number(delivery.total) }),
            },
            {
              icon: "alert-circle",
              label: t().deliveriesFailed,
              value: number(delivery.failed),
              tone: delivery.failed > 0 ? "bad" : undefined,
              meta: all ? undefined : t().openCount({ count: number(delivery.active) }),
            },
            ...(all
              ? [
                  { icon: "clock", label: t().deliveriesOpen, value: number(delivery.active), meta: t().waitingToSend },
                  { icon: "ban", label: t().deliveriesSuppressed, value: number(delivery.suppressed), meta: t().suppressedHint },
                ]
              : []),
          ]
        : [];
    const both = job && delivery;
    return [...jobCells(!both), ...deliveryCells(!both)];
  });
  const unreadFigures = () => figures().job === null || figures().delivery === null;

  // k2b-ui gap: the state timeline ignores a state's colour under the v2 palette (the series class wins over the fill), so
  // "failed" is not red; and below about 400 px its lane names and legend run past the canvas.
  const TIMELINE_STATES = () => [
    { state: "ok", label: t().succeeded, color: "#10b981" },
    { state: "error", label: t().failed, color: "#ef4444" },
    { state: "running", label: t().running, color: "#3b82f6" },
    { state: "stuck", label: t().neverFinished, color: "#f59e0b" },
  ];
  /** The job lanes as the chart draws them: a lane opens its source's runs, a mark its run. */
  const timelineRows = createMemo(() =>
    (timeline()?.rows ?? []).map((row) => ({
      label: row.label,
      tooltip: row.source,
      href: runsHref(query(), { ...state(), filters: { ...state().filters, source: row.source } }),
      intervals: row.intervals.map((interval) => ({
        from: interval.from,
        to: interval.to,
        state: interval.state,
        href: href({ run: { kind: "job", id: `${interval.traceId}:${interval.spanId}` } }),
        tooltip: [
          interval.name,
          TIMELINE_STATES().find((entry) => entry.state === interval.state)?.label,
          at(interval.startedAt),
          interval.durationMs === null ? null : duration()(interval.durationMs),
          interval.statusMessage?.trim().slice(0, 160) || null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    })),
  );
  /** Times on the timeline's axis: days only when the window is longer than one. */
  const timelineFormat = (value: number) => {
    const shown = timeline();
    return new Intl.DateTimeFormat(locale(), {
      timeZone: props.timeZone,
      ...(shown && shown.toMs - shown.fromMs > 86_400_000 ? { day: "2-digit", month: "short" } : {}),
      hour: "2-digit",
      minute: "2-digit",
    }).format(value);
  };

  const runsPane = () => (
    <Pane
      label={t().runs}
      scrollKey="gateway-ops-runs"
      status={
        <>
          <FilterBar
            query={query()}
            state={state()}
            onChange={change}
            base={base()}
            icons={{
              kind: "list",
              status: "circle-dashed",
              app: "apps",
              time: "clock",
              category: "tag",
              duration: "hourglass",
              source: "code",
              channel: "send",
            }}
            results={lead()}
            names={props.names}
          />
          <StatusRow lead={lead()} loading={loading()} filters={<ListOrder query={query()} state={state()} onChange={change} />} />
        </>
      }
    >
      <Show when={ignored()}>
        {(text) => (
          <Notice tone="warn" title={t().ignoredParts} actions={[{ label: t().hide, onClick: () => setIgnored(null) }]}>
            {text()}
          </Notice>
        )}
      </Show>
      <For each={notes()}>{(note) => <Notice tone="note">{note}</Notice>}</For>
      <For each={parts().filter((part) => part.error)}>
        {(part) => <Notice tone="bad">{t().unavailable({ kind: kindLabel(part.kind) })}</Notice>}
      </For>
      <Show when={cells().length > 0}>
        {/* k2b-ui gap: Cells stacks one cell per line on the phone; four key figures want 2x2 or one dense row there */}
        <KeyCells cells={cells()} />
      </Show>
      <Show when={unreadFigures()}>
        <Notice tone="bad">{t().figuresUnavailable}</Notice>
      </Show>
      {/* the job lanes while only jobs show and no run is open beside them */}
      <Show when={!props.run && timeline()}>
        {(shown) => (
          <Section
            icon="timeline"
            title={t().runTimeline}
            summary={
              shown().total > shown().shown
                ? t().timelineSample({ count: number(shown().shown), total: number(shown().total) })
                : t().timelineSummary
            }
          >
            <Canvas label={t().runTimeline} height={Math.max(160, 96 + shown().rows.length * 24)}>
              <Show when={shown().rows.length > 0} fallback={<Empty icon="timeline" text={t().noTimeline} />}>
                <Chart
                  kind="stateTimeline"
                  rows={timelineRows()}
                  states={TIMELINE_STATES()}
                  domain={[shown().fromMs, shown().toMs]}
                  xAxis={{ format: timelineFormat }}
                  legend
                  interactive
                  style={{ height: "100%" }}
                />
              </Show>
            </Canvas>
          </Section>
        )}
      </Show>
      <Show when={!failed()} fallback={<Failed text={t().unavailable({ kind: t().runs })} onRetry={() => void load(state())} />}>
        <Table
          label={t().runs}
          rows={rows()}
          rowKey={(row) => `${row.ref.kind}:${row.ref.id}`}
          sticky
          current={props.run ? `${props.run.kind}:${props.run.id}` : undefined}
          group={
            single()
              ? undefined
              : (row) => {
                  const part = parts().find((candidate) => candidate.kind === row.ref.kind);
                  const count = part?.total ?? null;
                  return {
                    key: row.ref.kind,
                    head: () => <Text weight="strong">{kindLabel(row.ref.kind)}</Text>,
                    count: count === null ? `${number(part?.rows.length ?? 0)}+` : number(count),
                  };
                }
          }
          open={openOf}
          empty={
            changed()
              ? {
                  icon: "filter-off",
                  text: t().noMatches,
                  action: { label: t().resetFilters, icon: "filter-off", href: runsHref(query(), base()) },
                }
              : { icon: "player-play", text: t().noRuns }
          }
          phone={(row) => ({
            lines: [
              row.name,
              [single() ? "" : kindLabel(row.ref.kind, false), appLabel(row.appId), row.detail].filter(Boolean).join(" · "),
            ],
            time: at(row.at),
            marks: statusChip(row.status),
          })}
          columns={[
            { title: t().name, width: { min: 220, default: 360 }, cell: (row) => ({ lines: [row.name, row.detail || "—"] }) },
            { title: t().status, width: { min: 150, default: 160 }, cell: (row) => statusChip(row.status) },
            { title: t().app, width: { min: 100, default: 130 }, cell: (row) => appChip(row.appId), drop: true },
            { title: t().started, width: { min: 120, default: 140 }, cell: (row) => at(row.at) },
            {
              title: t().duration,
              width: { min: 110, default: 130 },
              align: "end",
              cell: (row) => (row.durationMs === null ? "—" : (duration()(row.durationMs) ?? "—")),
              drop: true,
            },
          ]}
        />
        {/* each kind beside others shows its newest; its own list pages through all of it */}
        <Show when={!single() && parts().some((part) => part.more)}>
          <Bar
            end={
              <For each={parts().filter((part) => part.more)}>
                {(part) => (
                  <Button variant="text" href={runsHref(query(), onlyKind(part.kind))} forward>
                    {part.total === null
                      ? t().showMore({ kind: kindLabel(part.kind) })
                      : t().showAll({ count: number(part.total), kind: kindLabel(part.kind) })}
                  </Button>
                )}
              </For>
            }
          />
        </Show>
        <Show when={single() && pages() > 1}>
          <Bar
            start={<Text type="meta">{t().pageOf({ page: page(), pages: pages() })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={href({ page: page() - 1, run: null })} disabled={page() <= 1}>
                  {t().previous}
                </Button>
                <Button href={href({ page: page() + 1, run: null })} disabled={page() >= pages()} forward>
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Show>
    </Pane>
  );

  /** Successful job runs counted per minute and job: what the runs list cannot show one by one. */
  const minutesPane = () => {
    const data = () => minutes()?.minutes ?? null;
    const minutePages = () => Math.min(RUNS_PAGE_MAX, Math.max(1, Math.ceil((data()?.total ?? 0) / RUNS_PER_PAGE)));
    const minuteClock = createMemo(
      () =>
        new Intl.DateTimeFormat(locale(), {
          timeZone: props.timeZone,
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
    );
    const minuteAt = (iso: string) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : minuteClock().format(date);
    };
    const ms = (value: number | null) => (value === null ? "—" : (duration()(value) ?? "—"));
    return (
      <Pane
        label={t().minutesTab}
        scrollKey="gateway-ops-run-minutes"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              base={base()}
              icons={{
                kind: "list",
                status: "circle-dashed",
                app: "apps",
                time: "clock",
                category: "tag",
                duration: "hourglass",
                source: "code",
              }}
              names={props.names}
            />
            <StatusRow
              lead={t().minutesLead({ count: number(data()?.count ?? 0), n: data()?.count ?? 0 })}
              loading={loading()}
              facts={
                data()?.p95DurationMs != null
                  ? [
                      { before: "P95", value: ms(data()?.p95DurationMs ?? null) },
                      { before: t().longest, value: ms(data()?.maxDurationMs ?? null) },
                    ]
                  : []
              }
            />
          </>
        }
      >
        <Notice tone="note">{t().minutesNote}</Notice>
        <Show when={!failed() && !minutes()?.error} fallback={<Failed text={t().minutesUnavailable} onRetry={() => void load(state())} />}>
          <Table
            label={t().minutesTab}
            rows={data()?.minutes ?? []}
            rowKey={(row) => `${row.at}:${row.appId}:${row.source}:${row.category}:${row.name}`}
            sticky
            empty={
              changed()
                ? {
                    icon: "filter-off",
                    text: t().noMatches,
                    action: { label: t().resetFilters, icon: "filter-off", href: runsHref(query(), base(), { tab: "minutes" }) },
                  }
                : { icon: "check", text: t().noMinutes }
            }
            phone={(row) => ({
              lines: [row.name, [appLabel(row.appId), row.source].filter(Boolean).join(" · ")],
              time: minuteAt(row.at),
              marks: <Chip status="ok">{number(row.count)}</Chip>,
            })}
            columns={[
              { title: t().minute, width: { min: 110, default: 120 }, cell: (row) => minuteAt(row.at) },
              { title: t().name, width: { min: 220, default: 340 }, cell: (row) => ({ lines: [row.name, row.source] }) },
              { title: t().app, width: { min: 100, default: 130 }, cell: (row) => appChip(row.appId), drop: true },
              { title: t().count, width: { min: 80, default: 90 }, align: "end", cell: (row) => number(row.count) },
              { title: t().average, width: { min: 100, default: 110 }, align: "end", cell: (row) => ms(row.avgDurationMs), drop: true },
              { title: "P95", width: { min: 90, default: 100 }, align: "end", cell: (row) => ms(row.p95DurationMs), drop: true },
              { title: t().longest, width: { min: 100, default: 110 }, align: "end", cell: (row) => ms(row.maxDurationMs), drop: true },
            ]}
          />
          <Show when={minutePages() > 1}>
            <Bar
              start={<Text type="meta">{t().pageOf({ page: page(), pages: minutePages() })}</Text>}
              end={
                <>
                  <Button icon="chevron-left" href={href({ page: page() - 1, run: null })} disabled={page() <= 1}>
                    {t().previous}
                  </Button>
                  <Button href={href({ page: page() + 1, run: null })} disabled={page() >= minutePages()} forward>
                    {t().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Show>
      </Pane>
    );
  };

  const schedulesPane = () => {
    const data = props.schedules;
    const list = data?.schedules ?? [];
    return (
      <Pane
        label={t().schedules}
        scrollKey="gateway-ops-schedules"
        status={<StatusRow lead={t().schedulesCount({ count: number(list.length), n: list.length })} />}
      >
        <For each={data?.warnings ?? []}>{(warning) => <Notice tone="warn">{warning}</Notice>}</For>
        <Show when={!data?.error} fallback={<Failed text={t().schedulesUnavailable} onRetry={() => location.reload()} />}>
          <Table
            label={t().schedules}
            rows={list}
            rowKey={(row) => `${row.appId}:${row.schedulerId}:${row.id}`}
            empty={{ icon: "calendar-time", text: t().noSchedules }}
            phone={(row) => ({
              lines: [row.id, [row.appName, row.cron, row.lastError ? t().lastFailed : ""].filter(Boolean).join(" · ")],
              time: at(row.nextRunAt),
            })}
            columns={[
              { title: t().schedule, width: { min: 200, default: 300 }, cell: (row) => ({ lines: [row.id, row.schedulerId] }) },
              { title: t().app, width: { min: 90, default: 120 }, cell: (row) => row.appName, drop: true },
              { title: t().cron, width: { min: 110, default: 140 }, cell: (row) => ({ lines: [row.cron, row.timezone] }), drop: true },
              { title: t().nextRun, width: { min: 120, default: 140 }, cell: (row) => at(row.nextRunAt) },
              {
                title: t().lastResult,
                width: { min: 120, default: 160 },
                cell: (row) =>
                  row.lastError ? (
                    <Chip status="bad">{t().lastFailed}</Chip>
                  ) : row.lastCompletedAt ? (
                    <Chip status="ok">{t().succeeded}</Chip>
                  ) : (
                    "—"
                  ),
                drop: true,
              },
              {
                title: t().runNow,
                cell: (row) =>
                  row.handlerAvailable ? (
                    <RunNow appId={row.appId} schedulerId={row.schedulerId} scheduleId={row.id} lastRunId={row.lastRunId} />
                  ) : (
                    <Text type="meta" muted>
                      {t().handlerUnavailable}
                    </Text>
                  ),
              },
            ]}
          />
        </Show>
      </Pane>
    );
  };

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.run && props.tab === "runs" ? 440 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().views}
              items={[
                { label: t().runs, href: runsHref(query(), state()), current: props.tab === "runs" && state().filters.status !== "failed" },
                {
                  label: t().viewFailed,
                  icon: "alert-circle",
                  href: runsHref(query(), failedView()),
                  current: props.tab === "runs" && state().filters.status === "failed",
                },
                {
                  label: t().minutesTab,
                  icon: "chart-bar",
                  href: runsHref(query(), state(), { tab: "minutes" }),
                  current: props.tab === "minutes",
                },
                { label: t().schedules, icon: "calendar-time", href: `${RUNS_PATH}?tab=schedules`, current: props.tab === "schedules" },
              ]}
            />
          }
          end={
            <>
              <Show when={props.tab !== "schedules"}>
                <Input
                  type="search"
                  icon="search"
                  label={t().search}
                  placeholder={t().searchShort}
                  value={state().search ?? ""}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") search(input.value);
                    if (event.key === "Escape" && input.value) {
                      input.value = "";
                      search("");
                    }
                  }}
                />
              </Show>
              <Menu
                label={t().moreActions}
                items={[
                  { label: t().workflowDefinitions, icon: "binary-tree", href: "/admin/observability/workflows" },
                  { label: t().notificationDefinitions, icon: "bell-cog", href: "/admin/observability/deliveries?view=registry" },
                  { label: t().earlierNotifications, icon: "mail", href: "/admin/observability/deliveries?view=legacy" },
                ]}
              />
            </>
          }
        />
      }
    >
      <Show when={props.tab === "runs"} fallback={props.tab === "minutes" ? minutesPane() : schedulesPane()}>
        <Pane.Split>
          {runsPane()}
          <Show when={props.run}>
            {(ref) => (
              <RunRecordPane
                ref={ref()}
                record={props.record}
                timeZone={props.timeZone}
                closeHref={href({ run: null })}
                kindLabel={kindLabel(ref().kind, false)}
              />
            )}
          </Show>
        </Pane.Split>
      </Show>
    </AdminWorkspace>
  );
}
