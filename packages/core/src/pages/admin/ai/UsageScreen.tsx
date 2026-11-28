import type { AiUsageFeedback, AiUsageGroup, AiUsagePage, AiUsagePoint, AiUsageRun, AiUsageStats } from "@k2b/cloud/ai/admin";
import {
  type AiUsageQuery,
  aiQuotaHref,
  aiUsageHref,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatPercent,
  principalLabel,
} from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import {
  Avatar,
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Disclosure,
  Empty,
  type Fact,
  Facts,
  FilterBar,
  Inline,
  type NavProps,
  Notice,
  type OnNavigate,
  Pane,
  Row,
  Section,
  Table,
  Tabs,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import StateWord from "../_area/StateWord";
import { aiUsageMessages } from "../settings/_components/ai-usage-messages";
import { AI_COLOR } from "./frame";
import { hasPoints, TimeChart } from "./insight-chart";
import type { AiUsageData } from "./insight-data";
import { PageBar } from "./insight-parts";
import {
  type UsageListState,
  usageFromState,
  usageKindLabel,
  usageQuery,
  usageRangeLabel,
  usageReasonLabel,
  usageState,
} from "./usage-query";

type Compare = "users" | "models";
type Dimension = "users" | "models" | "tasks" | "apps" | "workflows";
/** The open entry beside a table: a run (`run=<kind>:<id>`) or a rating (`feedback=<id>`). */
type Open = { run: string | null; feedback: string | null };

const STEP = { "24h": 3_600_000, "7d": 86_400_000, "30d": 86_400_000, "90d": 86_400_000 } as const;

/**
 * KI › Nutzung on v2: the period's figures as one strip, the cost over time as the hero chart, then use and tokens;
 * the views (overview, people, models, feedback, runs) as tabs in the head, the filters as statements under it, the
 * tables dense, and a run or rating beside its table while the address names it. Every filter, view and open entry
 * lives in the address; a change of filters loads the report anew on the server.
 */
export default function UsageScreen(props: { nav: NavProps; data: AiUsageData }) {
  const locale = useLocale();
  const t = () => aiUsageMessages.resolve([locale()]).t;
  const toast = useToast();
  const report = () => props.data.report;
  const q = () => report().query;
  const unit = () => report().unit;
  const n = (value: number | null) => formatNumber(value, { locale: locale(), decimals: 0 });
  const cost = (value: number | null) => (value === null ? "—" : value.toLocaleString(locale(), { maximumSignificantDigits: 6 }));
  const percent = (part: number, total: number) => (total ? formatPercent(part / total, { locale: locale() }) : "—");
  const coverage = (value: number) => formatPercent(value, { locale: locale() });
  const date = (value: string) => formatDateTime(value, { locale: locale(), timeZone: props.data.timeZone });
  const duration = (value: number | null) => formatDurationMs(value, { locale: locale() });
  const person = (id: string | null, label: string | null) =>
    id ? principalLabel({ principal: { type: "user", userId: id }, displayName: label ?? undefined }, locale()) : t().unassigned;

  /** The address of the explorer with a change, the comparison and the open entry kept as asked. */
  const link = (patch: Partial<AiUsageQuery>, extra: { compare?: Compare; open?: Partial<Open> } = {}) => {
    const params = new URLSearchParams(aiUsageHref({ ...q(), page: undefined, ...patch }).split("?")[1]);
    const compare = extra.compare ?? props.data.compare;
    if ((patch.view ?? q().view) === "comparisons" && compare === "models") params.set("compare", "models");
    if (extra.open?.run) params.set("run", extra.open.run);
    if (extra.open?.feedback) params.set("feedback", extra.open.feedback);
    return `/admin/ai?${params}`;
  };
  const runsLink = (patch: Partial<AiUsageQuery>) =>
    link({ view: "runs", kind: undefined, status: undefined, task: undefined, errorCode: undefined, search: undefined, ...patch });

  // The filter bar: its names come from the server, so the first picture and the island agree.
  const nameOf = (field: string, id: string) => {
    if (field === "userId") {
      if (id === "unassigned") return t().unassigned;
      return person(id, id === q().userId ? props.data.userLabel : null);
    }
    return id;
  };
  // The open view's parts of the report; every other view is a link to its own address.
  const overviewView = () => (props.data.view.kind === "overview" ? props.data.view : undefined);
  const comparisonView = () => (props.data.view.kind === "comparisons" ? props.data.view : undefined);
  const feedbackView = () => (props.data.view.kind === "feedback" ? props.data.view : undefined);
  const runsView = () => (props.data.view.kind === "runs" ? props.data.view : undefined);
  const query = createMemo(() => usageQuery(locale(), q().view, q().range, nameOf));
  const state = createMemo(() => usageState(query(), q()));
  const names = createMemo(() => {
    const own = (key: "userId" | "modelId" | "providerModel" | "appId" | "task") => {
      const value = q()[key];
      return value ? [{ value, label: nameOf(key, value) }] : [];
    };
    return { userId: own("userId"), modelId: own("modelId"), providerModel: own("providerModel"), appId: own("appId"), task: own("task") };
  });
  /** The bar wrote the address already; the report of the new filters comes from the server. */
  const change = (next: UsageListState) => {
    const target = aiUsageHref(usageFromState(q(), next));
    if (target === aiUsageHref({ ...q(), page: q().page })) return;
    const params = new URLSearchParams(target.split("?")[1]);
    if (q().view === "comparisons" && props.data.compare === "models") params.set("compare", "models");
    window.location.replace(`/admin/ai?${params}`);
  };

  // The open run or rating, in the address; it opens and closes in place, and back and forward follow it.
  const [open, setOpen] = createSignal<Open>(props.data.open);
  const readOpen = () => {
    const params = new URLSearchParams(window.location.search);
    setOpen({ run: params.get("run"), feedback: params.get("feedback") });
  };
  onMount(() => {
    window.addEventListener("popstate", readOpen);
    onCleanup(() => window.removeEventListener("popstate", readOpen));
  });
  const inPlace =
    (next: Open): OnNavigate =>
    (event) => {
      setOpen(next);
      event.push(undefined, { scroll: "manual" });
    };
  const openRun = () => (open().run ? (runsView()?.runs.items.find((row) => `${row.kind}:${row.id}` === open().run) ?? null) : null);
  const openFeedback = () => (open().feedback ? (feedbackView()?.feedback.items.find((row) => row.id === open().feedback) ?? null) : null);
  const closed = () => link({});

  const statusText = (value: string) =>
    (
      ({
        completed: t().completed,
        failed: t().failed,
        aborted: t().aborted,
        queued: t().queued,
        running: t().running,
        waiting_for_action: t().waiting,
        pending: t().waiting,
        rejected: t().rejected,
        waiting_for_approval: t().waiting,
        waiting_for_frontend: t().waiting,
      }) as Record<string, string>
    )[value] ?? value;
  /** A run's state: failed in red with its word, every other state as a quiet dot and word (colour only for problems). */
  const RunState = (stateProps: { status: string }) => (
    <Show
      when={stateProps.status === "failed"}
      fallback={<StateWord muted={stateProps.status !== "completed"}>{statusText(stateProps.status)}</StateWord>}
    >
      <Chip status="bad">{statusText(stateProps.status)}</Chip>
    </Show>
  );

  const axis = (at: number) =>
    new Date(at).toLocaleString(locale(), {
      timeZone: props.data.timeZone,
      ...(q().range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" }),
    });
  const points = (value: (point: AiUsagePoint) => number | null) =>
    (overviewView()?.timeline ?? []).map((point) => ({ at: Date.parse(point.bucket), value: value(point) }));
  const costSeries = () => [{ label: t().cost, points: points((point) => point.cost) }];
  const useSeries = () => [
    { label: t().turns, points: points((point) => point.turns) },
    { label: t().errors, points: points((point) => point.failed) },
  ];
  const tokenSeries = () => [{ label: t().tokens, points: points((point) => point.tokens) }];

  /** The key figures of a cohort as one strip: runs, tokens, costs, negative ratings, each with what is measured. */
  const figures = (stats: AiUsageStats) => (
    // k2b-ui gap: Hero figure (#4360); the strip of key figures leads until the figure type 30 exists.
    <Cells>
      <Cells.Cell
        icon="receipt"
        color={AI_COLOR}
        label={`${t().cost} (${unit()})`}
        value={cost(stats.cost)}
        meta={`${coverage(stats.costCoverage)} ${t().measured}`}
        // slot for #4208/#4223 (DP): Cells trend, the cost per step (the overview's timeline cost) as a spark with t().costTrend
      />
      <Cells.Cell icon="player-play" label={t().runs} value={n(stats.runs)} meta={t().errorsCount({ count: n(stats.failed) })} />
      <Cells.Cell icon="coins" label={t().tokens} value={n(stats.tokens)} meta={`${coverage(stats.tokenCoverage)} ${t().measured}`} />
      <Cells.Cell
        icon="thumb-down"
        label={t().negativeFeedback}
        value={`${n(stats.negative)} / ${n(stats.rated)}`}
        meta={`${percent(stats.negative, stats.rated)} · ${t().feedbackCoverage} ${percent(stats.rated, stats.assistantMessages)}`}
      />
    </Cells>
  );

  const pager = <T,>(page: AiUsagePage<T>) => (
    <PageBar page={page.page} perPage={page.perPage} total={page.total} href={(next) => link({ page: next })} />
  );

  /** People, models, apps, workflows or tasks, one row each, with the drill-down into runs and ratings. */
  const groupTable = (dimension: Dimension, title: string, page: AiUsagePage<AiUsageGroup>) => {
    const label = (row: AiUsageGroup) =>
      dimension === "users" ? (row.id ? person(row.id, row.label) : t().unassigned) : (row.label ?? row.id ?? t().unassigned);
    const patch = (row: AiUsageGroup): Partial<AiUsageQuery> =>
      dimension === "users"
        ? { userId: row.id ?? "unassigned" }
        : dimension === "models"
          ? { modelId: row.id ?? undefined, providerModel: row.providerModel ?? undefined }
          : dimension === "tasks"
            ? { task: row.id ?? undefined, view: "runs" }
            : { appId: row.id ?? undefined };
    const target = (row: AiUsageGroup) =>
      dimension === "workflows" ? `/admin/observability/workflows?workflow=${encodeURIComponent(row.id ?? "")}` : link(patch(row));
    const sortable = dimension === "users" || dimension === "models";
    const sortBy = (sort: AiUsageQuery["sort"]) =>
      sortable ? { href: link({ sort, direction: q().sort === sort && q().direction === "desc" ? "asc" : "desc" }) } : undefined;
    const SORTED = ["runs", "tokens", "cost", "errors", "negative", "negativeRate"] as const;
    const rows = () => page.items;
    const position = SORTED.findIndex((sort) => sort === q().sort);
    const column = position < 0 ? undefined : position + 1;
    return (
      <Section title={title} count={n(page.total)}>
        <Table
          label={title}
          rows={rows()}
          rowKey={(row) => `${row.id}:${row.providerModel ?? ""}`}
          sort={sortable && column !== undefined ? { column, direction: q().direction === "asc" ? "ascending" : "descending" } : undefined}
          open={(row) => ({ href: target(row) })}
          empty={{ icon: "chart-bar-off", text: t().noResults }}
          phone={(row) => ({
            lines: [label(row), `${n(row.runs)} ${t().runs} · ${cost(row.cost)} ${unit()} · ${n(row.failed)} ${t().errors}`],
            ...(dimension === "users" && row.id ? { avatar: { name: label(row) } } : {}),
          })}
          columns={[
            {
              title,
              width: { min: 180, default: 240 },
              // slot for #4208/#4223 (DP): Column avatar for people (it replaces the Avatar in the cell), Column mark "cube" in AI_COLOR for models
              cell: (row) =>
                row.providerModel || (dimension === "workflows" && row.appId) ? (
                  { lines: [label(row), row.providerModel ?? row.appId ?? ""] }
                ) : dimension === "users" ? (
                  <Inline>
                    <Avatar name={label(row)} decorative />
                    {label(row)}
                  </Inline>
                ) : (
                  label(row)
                ),
            },
            { title: t().runs, width: { min: 80, default: 96 }, align: "end", sort: sortBy("runs"), cell: (row) => n(row.runs) },
            {
              title: t().tokens,
              width: { min: 90, default: 110 },
              align: "end",
              drop: true,
              sort: sortBy("tokens"),
              cell: (row) => n(row.tokens),
            },
            {
              title: `${t().cost} (${unit()})`,
              width: { min: 100, default: 120 },
              align: "end",
              sort: sortBy("cost"),
              cell: (row) => cost(row.cost),
            },
            {
              title: t().errors,
              width: { min: 90, default: 110 },
              align: "end",
              drop: true,
              sort: sortBy("errors"),
              cell: (row) =>
                // the failed runs of this row, one step away (text button in the cell)
                row.failed > 0 && dimension !== "workflows" ? (
                  <Button variant="text" href={runsLink({ ...patch(row), view: "runs", status: "failed" })}>
                    {`${n(row.failed)} · ${percent(row.failed, row.runs)}`}
                  </Button>
                ) : (
                  n(row.failed)
                ),
            },
            {
              title: t().feedback,
              width: { min: 110, default: 140 },
              align: "end",
              drop: true,
              sort: sortBy("negative"),
              cell: (row) =>
                row.negative > 0 && (dimension === "users" || dimension === "models") ? (
                  <Button variant="text" href={link({ ...patch(row), view: "feedback", rating: "down" })}>
                    {`${n(row.negative)} / ${n(row.rated)} ${t().negative}`}
                  </Button>
                ) : row.rated ? (
                  `${n(row.negative)} / ${n(row.rated)} ${t().negative}`
                ) : (
                  "—"
                ),
            },
            {
              title: t().negativeShare,
              width: { min: 100, default: 120 },
              align: "end",
              drop: true,
              sort: sortBy("negativeRate"),
              cell: (row) => percent(row.negative, row.rated),
            },
            {
              title: t().averageDuration,
              drop: true,
              cell: (row) =>
                dimension === "models"
                  ? t().modelSpeed({
                      average: duration(row.avgDurationMs),
                      p95: duration(row.p95DurationMs),
                      speed: n(row.avgOutputTokensPerSecond),
                      switched: n(row.switchesAway),
                    })
                  : `${duration(row.avgDurationMs)} · p95 ${duration(row.p95DurationMs)}`,
            },
          ]}
        />
        {pager(page)}
      </Section>
    );
  };

  const runFacts = (row: AiUsageRun): Fact[] => [
    {
      label: t().backgroundTask,
      value: <Text href={link({ view: "runs", task: row.task, kind: row.kind, page: undefined }, {})}>{row.task}</Text>,
      copy: row.task,
    },
    { label: t().status, value: <RunState status={row.status} /> },
    { label: t().runKind, value: usageKindLabel(t(), row.kind) },
    { label: t().received, value: date(row.createdAt) },
    { label: t().user, value: <Text href={link({ userId: row.userId ?? "unassigned" })}>{person(row.userId, row.userLabel)}</Text> },
    ...(row.modelId
      ? [
          {
            label: t().model,
            value: <Text href={link({ modelId: row.modelId, providerModel: row.providerModel ?? undefined })}>{row.modelId}</Text>,
            mono: true,
            copy: row.modelId,
          },
        ]
      : []),
    ...(row.providerModel ? [{ label: t().providerModel, value: row.providerModel, mono: true, copy: row.providerModel }] : []),
    ...(row.appId ? [{ label: t().application, value: row.appId }] : []),
    { label: t().tokens, value: n(row.tokens) },
    { label: `${t().cost} (${unit()})`, value: `${cost(row.cost)}${row.estimated ? ` · ${t().estimated}` : ""}` },
    { label: t().averageDuration, value: duration(row.durationMs) },
    ...(row.attempts === null ? [] : [{ label: t().attempts, value: n(row.attempts) }]),
    ...(row.errorCode ? [{ label: t().errorCode, value: row.errorCode, mono: true, copy: row.errorCode }] : []),
    { label: t().runId, value: row.id, mono: true, copy: row.id },
    ...(row.conversationId ? [{ label: t().conversationId, value: row.conversationId, mono: true, copy: row.conversationId }] : []),
    ...(row.turnId ? [{ label: t().turnId, value: row.turnId, mono: true, copy: row.turnId }] : []),
    ...(row.workflowRunId
      ? [
          {
            label: t().workflowRunId,
            value: <Text href={`/admin/observability/workflows?run=${encodeURIComponent(row.workflowRunId)}`}>{row.workflowRunId}</Text>,
            mono: true,
            copy: row.workflowRunId,
          },
        ]
      : []),
    ...(row.traceId ? [{ label: t().traceId, value: row.traceId, mono: true, copy: row.traceId }] : []),
  ];
  const feedbackFacts = (row: AiUsageFeedback): Fact[] => [
    { label: t().rating, value: row.rating === "up" ? <StateWord>{t().helpful}</StateWord> : <Chip status="warn">{t().needsWork}</Chip> },
    ...(row.reasons.length ? [{ label: t().reason, value: row.reasons.map((reason) => usageReasonLabel(t(), reason)).join(", ") }] : []),
    { label: t().user, value: <Text href={link({ userId: row.userId ?? "unassigned" })}>{person(row.userId, row.userLabel)}</Text> },
    ...(row.modelId
      ? [
          {
            label: t().model,
            value: <Text href={link({ modelId: row.modelId, providerModel: row.providerModel ?? undefined })}>{row.modelId}</Text>,
            mono: true,
            copy: row.modelId,
          },
        ]
      : []),
    ...(row.providerModel ? [{ label: t().providerModel, value: row.providerModel, mono: true }] : []),
    { label: t().message, value: row.conversationTitle },
    { label: t().responseCreated, value: date(row.createdAt) },
    { label: t().ratingUpdated, value: date(row.updatedAt) },
    { label: t().conversationId, value: row.conversationId, mono: true, copy: row.conversationId },
    { label: t().messageId, value: row.id, mono: true, copy: row.id },
  ];
  const copyAll = async (title: string, facts: Fact[], extra: string[] = []) => {
    const text = [
      title,
      ...extra,
      ...facts.map((fact) => `${fact.label}: ${fact.copy ?? (typeof fact.value === "string" ? fact.value : "")}`),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(t().copied, { status: "ok" });
    } catch {
      toast(t().copyFailed, { status: "bad" });
    }
  };

  const tabs = () => [
    { label: t().overviewTab, view: "overview" as const },
    { label: t().usersTitle, view: "comparisons" as const, compare: "users" as const },
    { label: t().models, view: "comparisons" as const, compare: "models" as const },
    { label: t().feedback, view: "feedback" as const },
    { label: t().runsTab, view: "runs" as const },
  ];
  const results = () => {
    const view = props.data.view;
    return view.kind === "runs"
      ? t().runsCount({ count: n(view.runs.total) })
      : view.kind === "feedback"
        ? t().ratingCount({ count: n(view.feedback.total) })
        : t().runsCount({ count: n(view.overview.runs) });
  };
  const kinds = ["chat", "background"] as const;

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while a run or rating is open: no empty half (identity rule 5)
      detail={openRun() || openFeedback() ? 400 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().views}
              items={tabs().map((tab) => ({
                label: tab.label,
                href: link({ view: tab.view }, { compare: tab.compare }),
                current: q().view === tab.view && (!tab.compare || tab.compare === props.data.compare),
              }))}
            />
          }
          end={
            <>
              <Show when={q().userId && q().userId !== "unassigned" ? q().userId : undefined}>
                {(userId) => (
                  <Button variant="text" icon="gauge" href={aiQuotaHref({ identity: userId(), identityType: "user", range: q().range })}>
                    {t().allowances}
                  </Button>
                )}
              </Show>
              {/* slot for #4208/#4223 (DP): FilterBar end, where this refresh stands at the end of the filter row; until then it stands in the head */}
              <Button variant="ghost" icon="refresh" href={link({ until: undefined })}>
                {t().refresh}
              </Button>
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().title}
          scrollKey={`admin-ai-usage-${q().view}`}
          width={openRun() || openFeedback() ? { min: 440, default: 720 } : undefined}
          status={
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              names={names()}
              timeZone={props.data.timeZone}
              results={results()}
            />
          }
        >
          <Show when={overviewView()}>
            {(view) => (
              <>
                {figures(view().overview)}
                <Section title={t().costOverTime} count={unit()} summary={usageRangeLabel(t(), q().range)}>
                  <Canvas label={t().costOverTime} height={220}>
                    <Show when={hasPoints(costSeries())} fallback={<Empty icon="chart-line" text={t().noCosts} />}>
                      <TimeChart series={costSeries()} step={STEP[q().range]} format={(value) => cost(value)} axis={axis} />
                    </Show>
                  </Canvas>
                </Section>
                <Section title={t().usageOverTime}>
                  <Canvas label={t().usageOverTime} height={180}>
                    <Show when={hasPoints(useSeries())} fallback={<Empty icon="chart-line" text={t().noTurns} />}>
                      <TimeChart series={useSeries()} step={STEP[q().range]} format={(value) => n(value)} axis={axis} />
                    </Show>
                  </Canvas>
                </Section>
                <Section title={t().tokenVolume}>
                  <Canvas label={t().tokenVolume} height={180}>
                    <Show when={hasPoints(tokenSeries())} fallback={<Empty icon="chart-line" text={t().noTokens} />}>
                      <TimeChart series={tokenSeries()} step={STEP[q().range]} format={(value) => n(value)} axis={axis} />
                    </Show>
                  </Canvas>
                </Section>
                <Section title={t().byKind}>
                  <For each={kinds}>
                    {(kind) => (
                      <Row
                        icon={kind === "chat" ? "message-2" : "clock-bolt"}
                        lines={[
                          usageKindLabel(t(), kind),
                          t().kindLine({ runs: n(view()[kind].runs), cost: cost(view()[kind].cost), unit: unit() }),
                        ]}
                        action={
                          view()[kind].failed > 0
                            ? {
                                label: t().errorsCount({ count: n(view()[kind].failed) }),
                                href: runsLink({ kind, status: "failed" }),
                              }
                            : undefined
                        }
                      />
                    )}
                  </For>
                  <Show when={view().overview.dictationMinutes > 0}>
                    <Row icon="microphone" lines={[t().dictationMinutes, n(view().overview.dictationMinutes)]} />
                  </Show>
                </Section>
                <Disclosure title={t().additionalStatistics}>
                  {groupTable("apps", t().application, view().apps)}
                  {groupTable("workflows", t().workflows, view().workflows)}
                  <Section title={t().launchedByApps} count={n(view().launches.total)}>
                    <Table
                      label={t().launchedByApps}
                      rows={view().launches.items}
                      empty={{ icon: "apps", text: t().noLaunches }}
                      columns={[
                        { title: t().application, cell: (row) => row.appId },
                        { title: t().chats, width: { min: 80, default: 100 }, align: "end", cell: (row) => n(row.chats) },
                        { title: t().users, width: { min: 80, default: 100 }, align: "end", cell: (row) => n(row.users) },
                      ]}
                    />
                    {pager(view().launches)}
                  </Section>
                  <Text muted>
                    {t().capabilitiesMoved} <Text href="/admin/observability/capabilities">{t().capabilities}</Text>
                  </Text>
                </Disclosure>
                <Disclosure title={t().dataNotes}>
                  <Text
                    muted
                  >{`${t().periodHelp} ${date(report().since)} – ${date(report().until)}. ${t().totalsHelp} ${t().costOverTimeDescription}`}</Text>
                  <Show when={view().unassignedBackgroundRuns > 0}>
                    <Notice
                      tone="note"
                      actions={[{ label: t().showUnassigned, href: runsLink({ kind: "background", userId: "unassigned" }) }]}
                    >
                      {t().unassignedHelp({ count: n(view().unassignedBackgroundRuns) })}
                    </Notice>
                  </Show>
                </Disclosure>
              </>
            )}
          </Show>
          <Show when={comparisonView()}>
            {(view) => (
              <>
                {figures(view().overview)}
                {groupTable(props.data.compare, props.data.compare === "users" ? t().usersTitle : t().models, view().rows)}
                <Text type="meta" muted>
                  {t().comparisonHelp}
                </Text>
              </>
            )}
          </Show>
          <Show when={feedbackView()}>
            {(view) => (
              <>
                {figures(view().chat)}
                <Section title={t().feedback} count={n(view().feedback.total)} summary={t().feedbackHelp}>
                  <Table
                    label={t().feedback}
                    rows={view().feedback.items}
                    rowKey={(row) => row.id}
                    current={openFeedback()?.id}
                    open={(row) => {
                      const target = { run: null, feedback: row.id };
                      return { href: link({}, { open: target }), onNavigate: inPlace(target) };
                    }}
                    empty={{ icon: "message-off", text: t().noMessageFeedback }}
                    phone={(row) => ({
                      avatar: { name: person(row.userId, row.userLabel) },
                      lines: [
                        row.comment ?? (row.reasons.length ? usageReasonLabel(t(), row.reasons[0]!) : t().commentOnly),
                        `${row.rating === "up" ? t().helpful : t().needsWork} · ${person(row.userId, row.userLabel)}`,
                      ],
                      time: date(row.updatedAt),
                    })}
                    columns={[
                      {
                        title: t().rating,
                        width: { min: 200, default: 210 },
                        cell: (row) =>
                          row.rating === "up" ? <StateWord>{t().helpful}</StateWord> : <Chip status="warn">{t().needsWork}</Chip>,
                      },
                      {
                        title: t().user,
                        width: { min: 140, default: 180 },
                        // slot for #4208/#4223 (DP): Column avatar of the person (it replaces the Avatar in the cell)
                        cell: (row) => (
                          <Inline>
                            <Avatar name={person(row.userId, row.userLabel)} decorative />
                            {person(row.userId, row.userLabel)}
                          </Inline>
                        ),
                      },
                      // beside an open rating its reasons, model and comment stand in the detail; the columns only fit without one
                      ...(openFeedback()
                        ? []
                        : [
                            {
                              title: t().reason,
                              width: { min: 120, default: 160 },
                              drop: true,
                              cell: (row: AiUsageFeedback) => row.reasons.map((reason) => usageReasonLabel(t(), reason)).join(", ") || "—",
                            },
                            {
                              title: t().model,
                              width: { min: 120, default: 150 },
                              drop: true,
                              cell: (row: AiUsageFeedback) => row.modelId ?? t().unknown,
                            },
                            { title: t().comment, drop: true, cell: (row: AiUsageFeedback) => row.comment ?? "" },
                          ]),
                    ]}
                  />
                  {pager(view().feedback)}
                </Section>
              </>
            )}
          </Show>
          <Show when={runsView()}>
            {(view) => (
              <Section title={t().runsTab} count={n(view().runs.total)} summary={t().runsHelp}>
                <Table
                  label={t().runsTab}
                  rows={view().runs.items}
                  rowKey={(row) => `${row.kind}:${row.id}`}
                  current={openRun() ? `${openRun()!.kind}:${openRun()!.id}` : undefined}
                  open={(row) => {
                    const target = { run: `${row.kind}:${row.id}`, feedback: null };
                    return { href: link({}, { open: target }), onNavigate: inPlace(target) };
                  }}
                  empty={{ icon: "list-search", text: t().noResults }}
                  phone={(row) => ({
                    lines: [row.task, `${statusText(row.status)} · ${usageKindLabel(t(), row.kind)} · ${row.modelId ?? t().unknown}`],
                    time: date(row.createdAt),
                  })}
                  columns={[
                    {
                      title: t().backgroundTask,
                      width: { min: 160, default: 220 },
                      cell: (row) => row.task,
                    },
                    { title: t().status, width: { min: 120, default: 140 }, cell: (row) => <RunState status={row.status} /> },
                    { title: t().model, width: { min: 120, default: 150 }, drop: true, cell: (row) => row.modelId ?? t().unknown },
                    {
                      title: t().user,
                      width: { min: 120, default: 150 },
                      drop: true,
                      cell: (row) => person(row.userId, row.userLabel),
                    },
                    // beside an open run its time stands in the detail; the column only fits without one
                    ...(openRun() ? [] : [{ title: t().received, drop: true, cell: (row: AiUsageRun) => date(row.createdAt) }]),
                  ]}
                />
                {pager(view().runs)}
              </Section>
            )}
          </Show>
        </Pane>
        <Show when={openRun()}>
          {(row) => (
            <Pane
              detail
              label={row().task}
              back={{ label: t().runsTab, href: closed(), onNavigate: inPlace({ run: null, feedback: null }) }}
              head={
                <Bar
                  start={<Text type="body">{row().task}</Text>}
                  end={
                    <>
                      <Button icon="copy" onClick={() => void copyAll(row().task, runFacts(row()), row().error ? [row().error!] : [])}>
                        {t().copyDetails}
                      </Button>
                      <Button
                        variant="ghost"
                        icon="x"
                        label={t().close}
                        href={closed()}
                        onNavigate={inPlace({ run: null, feedback: null })}
                      />
                    </>
                  }
                />
              }
            >
              <Show when={row().error ?? (row().status === "failed" ? t().noStoredError : null)}>
                {(error) => (
                  <Notice tone="bad" icon="alert-triangle" title={t().error}>
                    {error()}
                  </Notice>
                )}
              </Show>
              <Section title={t().details}>
                <Facts items={runFacts(row())} />
              </Section>
            </Pane>
          )}
        </Show>
        <Show when={openFeedback()}>
          {(row) => (
            <Pane
              detail
              label={t().feedback}
              back={{ label: t().feedback, href: closed(), onNavigate: inPlace({ run: null, feedback: null }) }}
              head={
                <Bar
                  start={<Text type="body">{row().conversationTitle}</Text>}
                  end={
                    <>
                      <Button
                        icon="copy"
                        onClick={() => void copyAll(t().feedback, feedbackFacts(row()), row().comment ? [row().comment!] : [])}
                      >
                        {t().copyDetails}
                      </Button>
                      <Button
                        variant="ghost"
                        icon="x"
                        label={t().close}
                        href={closed()}
                        onNavigate={inPlace({ run: null, feedback: null })}
                      />
                    </>
                  }
                />
              }
            >
              <Show when={row().comment}>
                {(comment) => (
                  <Section title={t().comment}>
                    <Text type="body">{comment()}</Text>
                  </Section>
                )}
              </Show>
              <Section title={t().details}>
                <Facts items={feedbackFacts(row())} />
              </Section>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
