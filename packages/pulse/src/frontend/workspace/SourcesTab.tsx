import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, RowGroup, Skeleton, StatusBadge, StatusRow, TaskRow } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type { PulseSource } from "../../contracts";
import type { pulseMessages } from "../../messages";
import { usePulseMessages } from "../use-messages";
import { type AttentionItem, type BasePageState, newestArrival, sourceProblem, sourcesSummary } from "./flat-state";
import { compactDate, compactDay, type PulseDateContext } from "./helpers";

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

export type SourcesTabProps = {
  state: Exclude<BasePageState, "noAccess">;
  baseName: string;
  /** When and by whom the base was created, for the empty state. */
  created: { at: string; by: string | null };
  sources: PulseSource[];
  attention: AttentionItem[];
  firedAlerts: number;
  selectedSourceId: string;
  dateContext: PulseDateContext;
  canWrite: boolean;
  /** The time the store state was read: rows below a lost store show this state. */
  readAt: string;
  storeDownSince: string | null;
  openSource: (sourceId: string) => void;
  openAlert: (alertId: string) => void;
  addSource: (kind?: "metrics" | "http_ingest") => void;
  connectWithGustav: () => void;
};

const now = (context: PulseDateContext) => context.now ?? new Date();
/** "vor 22 s": the age of a time against the page's clock. */
export const ago = (value: string, context: PulseDateContext) => dates.formatTimeSpan(value, { ...context, base: now(context) });
/** "14:05" today, "19. Nov. 14:05" before: times that must not age while the page waits. */
export const absoluteTime = (value: string, context: PulseDateContext) => {
  const sameDay = compactDay(value, context) === compactDay(new Date(now(context)).toISOString(), context);
  return sameDay ? compactDate(value, context) : `${compactDay(value, context)} ${compactDate(value, context)}`;
};
/** "15 min", "60 s", "2 h": an interval in the largest whole unit. */
export const interval = (seconds: number) =>
  seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;

const sourceMeta = (source: PulseSource, t: Messages) =>
  [
    source.kind === "metrics" ? t.metricsEndpoint : t.httpIngest,
    source.kind === "metrics"
      ? t.scrapeEvery({ seconds: source.scrapeIntervalSeconds ?? 60 })
      : source.expectEverySeconds
        ? t.expectedEvery({ every: interval(source.expectEverySeconds) })
        : source.expectDailyBy
          ? t.expectedDaily({ time: source.expectDailyBy })
          : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** The state chip of one source: one word, a dot, a tone (K7). */
const sourceState = (source: PulseSource, t: Messages): { label: string; tone: "ok" | "warning" | "error" | "neutral" } => {
  if (!source.enabled) return { label: t.paused, tone: "neutral" };
  const problem = sourceProblem(source);
  if (problem === "rejected") return { label: t.stateRefused, tone: "error" };
  if (problem === "error") return { label: t.error, tone: "error" };
  if (problem === "throttled") return { label: t.throttled, tone: "warning" };
  if (problem === "stale") return { label: t.stale, tone: "warning" };
  if (source.status.newestDataAt ?? source.lastSeenAt) return { label: t.stateReceiving, tone: "ok" };
  return { label: t.waiting, tone: "neutral" };
};

/** The sentence and detail line of one attention row. */
export const attentionText = (item: AttentionItem, t: Messages, context: PulseDateContext): { text: string; detail: string } => {
  if (item.kind === "alert") {
    const alert = item.alert;
    const text =
      alert.state === "firing"
        ? t.alertFired({ name: alert.name })
        : alert.state === "error"
          ? t.alertCannotCheck({ name: alert.name })
          : t.alertNoData({ name: alert.name });
    const limit =
      alert.threshold === null || alert.comparison === null
        ? null
        : (alert.comparison === "above" ? t.alertLimitAbove : t.alertLimitBelow)({ threshold: String(alert.threshold) });
    const severity = alert.state === "firing" ? (alert.severity === "critical" ? t.severityCritical : t.severityWarning) : null;
    const detail = [
      severity,
      alert.value === null
        ? t.storeDownSince({ time: absoluteTime(alert.since, context) })
        : t.alertSinceValue({ since: absoluteTime(alert.since, context), value: String(alert.value) }),
      limit,
      alert.state === "error" && alert.errorCode ? alert.errorCode : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { text, detail };
  }
  const source = item.source;
  const arrival = source.status.newestDataAt ?? source.lastSeenAt;
  const last = arrival ? t.lastArrivalAt({ time: absoluteTime(arrival, context) }) : t.noArrivalYet;
  if (item.problem === "rejected") {
    const rejected = source.status.rejected!;
    return {
      text: item.since
        ? t.attentionNothingArrives({ name: source.name, since: absoluteTime(item.since, context) })
        : t.attentionRefused({ name: source.name }),
      detail: [t.refusedCount({ count: rejected.last24h }), rejected.lastReason].filter(Boolean).join(" · "),
    };
  }
  if (item.problem === "error")
    return { text: t.attentionFetchFails({ name: source.name }), detail: [source.status.lastError, last].filter(Boolean).join(" · ") };
  if (item.problem === "throttled") return { text: t.attentionThrottled({ name: source.name }), detail: t.throttledDetail };
  const expectation = sourceMeta(source, t).split(" · ")[1];
  return { text: t.attentionStale({ name: source.name }), detail: [expectation, last].filter(Boolean).join(" · ") };
};

const attentionIcon = (item: AttentionItem) =>
  item.kind === "alert"
    ? "ti ti-bell-ringing"
    : item.problem === "stale"
      ? "ti ti-clock-exclamation"
      : item.problem === "throttled"
        ? "ti ti-gauge"
        : "ti ti-circle-x";

export default function SourcesTab(props: SourcesTabProps) {
  const t = usePulseMessages();
  const storeDown = () => props.state === "storeDown";
  const summary = () => sourcesSummary(props.sources);
  const lead = (): JSX.Element => {
    const value = summary();
    if (value.kind === "all")
      return (
        <span class="pulse-lead">
          <i class="ti ti-circle-check pulse-lead__icon" data-tone="ok" aria-hidden="true" />
          {t().summaryAll({ total: value.total })}
        </span>
      );
    if (value.kind === "some") return t().summarySome(value);
    if (value.kind === "attention") return t().summaryAttention(value);
    return t().emptyTitle({ base: props.baseName });
  };
  const facts = () => {
    const newest = newestArrival(props.sources);
    return [
      ...(newest ? [{ value: ago(newest, props.dateContext), label: t().factLastArrival }] : []),
      ...(props.firedAlerts ? [{ value: String(props.firedAlerts), label: t().factAlerts({ count: props.firedAlerts }) }] : []),
    ];
  };
  const arrival = (source: PulseSource) => {
    const at = source.status.newestDataAt ?? source.lastSeenAt;
    if (!at) return "—";
    return storeDown() ? absoluteTime(at, props.dateContext) : ago(at, props.dateContext);
  };
  const columns = (): DataTableColumn<PulseSource>[] => [
    { id: "source", header: t().source, value: "name", primary: true, list: "title" },
    { id: "state", header: t().columnState, list: "end", nowrap: true },
    { id: "arrival", header: t().columnLastArrival, list: "meta", nowrap: true, priority: 2 },
    { id: "today", header: t().columnToday, align: "right", nowrap: true, priority: 3 },
  ];
  const renderCell = (source: PulseSource, col: DataTableColumn<PulseSource>): JSX.Element => {
    if (col.id === "source")
      return (
        <span class="pulse-source-cell">
          <span class="pulse-source-cell__name">{source.name}</span>
          <span class="pulse-source-cell__meta">{sourceMeta(source, t())}</span>
        </span>
      );
    if (col.id === "state") {
      if (storeDown()) return <span class="pulse-quiet">{t().stateReceived}</span>;
      const state = sourceState(source, t());
      return <StatusBadge label={state.label} tone={state.tone} />;
    }
    if (col.id === "arrival") return <span class="pulse-quiet">{arrival(source)}</span>;
    if (col.id === "today")
      return (
        <span class="tabular-nums">{source.todayCount == null ? "—" : source.todayCount.toLocaleString(props.dateContext.locale)}</span>
      );
    return null;
  };
  return (
    <section class="pulse-tab" aria-label={t().sources}>
      <Show
        when={props.state !== "loading"}
        fallback={
          <>
            <StatusRow lead={<Skeleton class="pulse-lead-skeleton" />} />
            <DataTable rows={[]} columns={columns()} loading loadingRows={4} getRowId={(source) => source.id} ariaLabel={t().sources} />
            <span class="sr-only" role="status">
              {t().baseLoading}
            </span>
          </>
        }
      >
        <Show
          when={props.state !== "empty"}
          fallback={
            <>
              <StatusRow
                lead={t().emptyTitle({ base: props.baseName })}
                facts={[
                  {
                    value: "",
                    label: props.created.by
                      ? t().emptyCreatedBy({ when: absoluteTime(props.created.at, props.dateContext), who: props.created.by })
                      : t().emptyCreated({ when: absoluteTime(props.created.at, props.dateContext) }),
                  },
                ]}
              />
              <p class="pulse-line">{props.canWrite ? t().emptyWhy : `${t().emptyWhy} ${t().overviewEmptyReadOnly}`}</p>
              <RowGroup title={t().emptyWaysTitle} level={3} class="pulse-ways">
                <div class="k2b-divided">
                  <TaskRow
                    icon="ti ti-send"
                    text={t().wayIngestTitle}
                    detail={t().wayIngestDetail}
                    action={t().wayCreate}
                    disabled={!props.canWrite}
                    onClick={() => props.addSource("http_ingest")}
                  />
                  <TaskRow
                    icon="ti ti-download"
                    text={t().wayScrapeTitle}
                    detail={t().wayScrapeDetail}
                    action={t().wayCreate}
                    disabled={!props.canWrite}
                    onClick={() => props.addSource("metrics")}
                  />
                  <TaskRow
                    class="pulse-way--ai"
                    icon="ti ti-sparkles"
                    text={t().wayGustavTitle}
                    detail={t().wayGustavDetail}
                    action={t().wayAskGustav}
                    onClick={props.connectWithGustav}
                  />
                </div>
              </RowGroup>
            </>
          }
        >
          <Show when={storeDown()} fallback={<StatusRow lead={lead()} facts={facts()} line={!props.attention.length} />}>
            <StatusRow
              lead={
                <span class="pulse-lead">
                  <span class="pulse-dot" data-tone="danger" aria-hidden="true" />
                  {t().storeDownTitle}
                </span>
              }
              state={{
                tone: "danger",
                icon: "ti ti-database-off",
                label: props.storeDownSince
                  ? `${t().storeDownSince({ time: absoluteTime(props.storeDownSince, props.dateContext) })} · ${t().storeDownChecks}`
                  : t().storeDownChecks,
              }}
            />
            <p class="pulse-line">{t().storeDownConsequence({ time: absoluteTime(props.readAt, props.dateContext) })}</p>
          </Show>
          <Show when={!storeDown() && props.attention.length}>
            <RowGroup title={t().attentionTitle} count={props.attention.length} level={3} class="pulse-attention">
              <div class="k2b-divided">
                <For each={props.attention}>
                  {(item) => {
                    const copy = () => attentionText(item, t(), props.dateContext);
                    return (
                      <TaskRow
                        class={`pulse-attention__row pulse-attention__row--${item.tone}`}
                        icon={attentionIcon(item)}
                        text={copy().text}
                        detail={copy().detail}
                        action={t().openDetail}
                        onClick={() => (item.kind === "source" ? props.openSource(item.source.id) : props.openAlert(item.alert.reference))}
                      />
                    );
                  }}
                </For>
              </div>
            </RowGroup>
          </Show>
          <DataTable
            class={storeDown() ? "pulse-sources pulse-sources--frozen" : "pulse-sources"}
            rows={props.sources}
            columns={columns()}
            getRowId={(source) => source.id}
            selectedRowId={props.selectedSourceId || null}
            onRowClick={(source) => props.openSource(source.id)}
            ariaLabel={t().sources}
            renderCell={({ row, col }) => renderCell(row, col)}
          />
          <Show when={!props.canWrite}>
            <p class="pulse-line pulse-line--quiet">
              <i class="ti ti-eye" aria-hidden="true" />
              {t().readOnlyLine}
            </p>
          </Show>
        </Show>
      </Show>
    </section>
  );
}
