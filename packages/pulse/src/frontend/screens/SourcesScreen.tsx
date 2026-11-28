import { ResourceApiKeySection } from "@k2b/cloud/access/ui";
import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { navigateTo } from "@k2b/ssr/nav";
import { text } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  Dialog,
  Empty,
  Facts,
  Inline,
  Input,
  List,
  Mark,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  Prose,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import type { AlertRule } from "../../alert-contracts";
import type { FetchMinute, FetchSlot, PulseBaseRead, PulseSource, SourceAlert, SourceEvent } from "../../contracts";
import { localizedSourceError } from "../../messages";
import type { AlertAttention } from "../../service/base-attention";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { compactDate, compactDateWithDelta, type PulseDateContext } from "../workspace/date-format";
import { installPeriodicRefresh } from "../workspace/periodic-refresh";
import { launchPulseOverviewAssistant, launchPulseSqlAssistant } from "../workspace/pulse-assistant-launch";
import { buildPulseWorkspaceHref } from "../workspace/routes";
import { createSourceController } from "../workspace/source-controller";
import { sourceStatus } from "../workspace/source-helpers";
import { installStoreRecheck } from "../workspace/store-recheck";
import type { PulseWorkspaceProps } from "../workspace/types";
import { BaseGone, createPulseWorkspaceQueries } from "../workspace/workspace-queries";
import BaseFrame, { baseHref } from "./BaseFrame";
import { useScreenMessages } from "./messages";
import { EditSourceDialog, NewSourceDialog } from "./SourceDialogs";
import { SourcesHero } from "./SourcesHero";
import { FetchLogDrawing, FetchTicksDrawing, SourceHourDrawing } from "./sources-drawings";

export type SourcesScreenProps = PulseWorkspaceProps & {
  /** `?q=`: the words the source list is filtered by. */
  initialSearch?: string;
  /** How many sources the base has; the server reads only the first page of them. */
  sourceCount?: number;
};

type Words = ReturnType<ReturnType<typeof usePulseMessages>>;

const stateWord = (source: PulseSource, t: Words) => {
  const status = sourceStatus(source, t);
  const tone = { ok: "ok", warning: "warn", error: "bad", neutral: undefined } as const;
  const kind = tone[status.tone];
  return (
    <Inline>
      <Text tone={kind} muted={kind === undefined}>
        ●
      </Text>
      <Text tone={kind === "ok" ? undefined : kind} muted={kind === undefined} weight={kind === "ok" ? undefined : "medium"}>
        {status.label}
      </Text>
    </Inline>
  );
};

/** An address that may break after each of its slashes, so it wraps at its segments and never inside a word. */
const atSegments = (address: string) => address.split(/(?<=\/)/).map((part) => [part, <wbr />]);

/** The mark of a source's kind: a scraped metrics endpoint and pushed events look different in every list. */
export const sourceMark = (source: PulseSource) =>
  source.kind === "metrics" ? { icon: "chart-dots", color: "#7c3aed" } : { icon: "webhook", color: "#0891b2" };

/** The path every push source sends its values to. */
const INGEST_PATH = "/api/pulse/ingest";

const curlExample = (origin: string) => `curl -fsS -X POST ${origin}${INGEST_PATH} \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: import-2026-10-19-0001" \\
  --data '{
    "metrics": [
      { "name": "orders.created", "value": 1, "type": "counter", "dimensions": { "channel": "webshop" } },
      { "name": "solar.output_watts", "value": 4200, "type": "gauge", "unit": "W", "dimensions": { "site": "warehouse" } }
    ],
    "events": [
      { "kind": "order.created", "dimensions": { "channel": "webshop" }, "payload": { "orderId": "demo-1001" } },
      { "kind": "import.finished", "dimensions": { "dataset": "inventory" }, "payload": { "rows": 128 } }
    ],
    "states": [
      { "key": "checkout.enabled", "value": true },
      { "key": "integration.online", "value": true, "dimensions": { "integration": "webshop" } }
    ]
  }'`;

/**
 * The sources of one base on v2: what needs attention (store, fired alerts) above the source table, the open source
 * beside it. The address holds the open source and the search; the server renders the first picture with its data.
 */
export default function SourcesScreen(props: SourcesScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const toast = useToast();
  const baseId = props.initialBaseId;
  const selectedSourceId = () => props.initialRouteState.sourceId;
  // the fetches of the last minutes in words, for assistive technology
  const fetchesLabel = (slots: readonly FetchSlot[]) =>
    words().fetchesSlots({
      ok: number(slots.filter((slot) => slot === "ok").length),
      failed: number(slots.filter((slot) => slot === "bad").length),
    });
  // the phone's second line: the kind, and today's values (the state stands as a chip at its end)
  // the phone's second line (study B): a problem first, in its colour ("● Fehler seit 10:40"), then the kind and
  // today's values; a source that delivers starts with its kind
  const phoneLine = (source: PulseSource) => {
    const rest = [
      source.kind === "metrics" ? t().metricsEndpoint : t().httpIngest,
      source.todayCount ? words().valuesTodayShort({ count: number(source.todayCount) }) : words().noValuesToday,
    ].join(" · ");
    const status = sourceStatus(source, t());
    if (status.tone === "ok") return rest;
    const tone = status.tone === "error" ? "bad" : status.tone === "warning" ? "warn" : undefined;
    const since =
      status.tone === "error" && source.lastErrorAt
        ? ` ${words().sinceTime({ time: compactDate(source.lastErrorAt, dateContext()) })}`
        : "";
    return (
      <>
        <Text tone={tone} muted={tone === undefined}>
          {`● ${status.label}${since}`}
        </Text>
        {` · ${rest}`}
      </>
    );
  };
  const [loading, setLoading] = createSignal(false);
  const [search, setSearch] = createSignal(props.initialSearch ?? "");
  const [adding, setAdding] = createSignal(false);
  const [editing, setEditing] = createSignal<PulseSource | null>(null);
  const [assistantPending, setAssistantPending] = createSignal(false);
  const [removedNotice, setRemovedNotice] = createSignal(props.initialNotice === "dashboards-removed");
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // the list is searched on the server once the words settle, not on every keystroke
  const [settled, setSettled] = createSignal(props.initialSearch ?? "");
  let settle: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(settle));
  const queries = createPulseWorkspaceQueries(props, selectedSourceId, () => true, settled);
  const sources = () => queries.baseData.data() ?? props.initialSources;
  // the figures of all sources, read with their own aggregate; the list below is one page of them
  const figures = () => queries.figures.data() ?? props.initialFigures ?? null;
  const base = () => queries.base.data() ?? props.initialBase;
  const baseName = () => base()?.name ?? t().appName;
  const selected = () => sources().find((source) => source.id === selectedSourceId()) ?? null;
  // k2b-ui gap: tables do not virtualize yet (lane MW); the server sends SOURCES_PAGE rows at a time, more on request.
  const shown = sources;
  const readQueries = () =>
    // the figures belong to the page's reads, so a failed refresh of them shows like any other
    selectedSourceId()
      ? [queries.base, queries.baseData, queries.figures, queries.sourceDetail]
      : [queries.base, queries.baseData, queries.figures];
  const writeBlocked = () => readQueries().some((query) => query.loading() || query.stale() || query.error() !== null);
  const readError = () =>
    readQueries()
      .find((query) => query.error())
      ?.error() ?? null;
  const refreshing = () => readQueries().some((query) => query.loading() || query.refreshing());
  const dateContext = (): PulseDateContext => ({ ...props.initialDateConfig, now: props.initialNow });
  const when = (value: string) => compactDateWithDelta(value, dateContext());

  // The source list follows collection while the page is visible; the open source with it.
  installPeriodicRefresh({
    active: () => !loading(),
    refresh: async () => {
      await Promise.all([
        queries.baseData.refresh(),
        queries.figures.refresh(),
        ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : []),
      ]);
      const error = [queries.baseData, queries.sourceDetail].find((query) => query.error())?.error();
      if (error) throw error;
    },
  });
  // The store cannot take or answer data: Pulse checks again every 30 s while visible and reloads the list once it answers.
  const store = installStoreRecheck({
    initial: props.initialAttention?.store ?? { unavailable: false, since: null },
    failedSince: () => base()?.store.state === "failed",
    watching: () => true,
    check: async () => (await jsonFetch<PulseBaseRead>(`/api/pulse/bases/${baseId}`)).outage,
    recovered: async () => {
      await Promise.all([queries.base.refresh(), queries.baseData.refresh(), queries.figures.refresh()]);
    },
  });
  const storeDownSince = () => store.since() ?? base()?.store.errorAt ?? null;
  // A base the person lost access to leaves; Pulse opens the next base they can open in its place.
  createEffect(
    on(
      queries.base.error,
      (error) => {
        if (error instanceof BaseGone) navigateTo("/app/pulse");
      },
      { defer: true },
    ),
  );

  const launch = async (start: () => ReturnType<typeof launchPulseOverviewAssistant>) => {
    if (assistantPending()) return;
    setAssistantPending(true);
    try {
      const result = await start();
      if (!disposed) navigateTo(result.href);
    } catch {
      if (!disposed) toast(t().assistantRetry, { status: "bad" });
    } finally {
      if (!disposed) setAssistantPending(false);
    }
  };
  const askAssistant = () => launch(() => launchPulseOverviewAssistant({ base: { id: baseId, name: baseName() }, locale: locale() }));
  const adjustAlert = (alertId: string) =>
    launch(async () => {
      const rule = await jsonFetch<AlertRule>(`/api/pulse/bases/${baseId}/alerts/${encodeURIComponent(alertId)}`);
      return launchPulseSqlAssistant({
        base: { id: baseId, name: baseName() },
        sql: rule.sql,
        params: rule.params,
        queryName: rule.name,
        locale: locale(),
      });
    });

  const listHref = () => `${baseHref(baseId)}${search().trim() ? `?q=${encodeURIComponent(search().trim())}` : ""}`;
  const sourceHref = (source: Pick<PulseSource, "id">) =>
    `${buildPulseWorkspaceHref({ baseId, state: { view: "sources", sourceId: source.id } })}${search().trim() ? `?q=${encodeURIComponent(search().trim())}` : ""}`;
  const controller = createSourceController({
    selectedBaseId: () => baseId,
    notify: (text, status) => toast(text, { status }),
    confirm: (question) => Dialog.confirm({ ...question, cancel: words().cancel }),
    loading,
    setLoading,
    selectedSourceId,
    navigate: (state) =>
      navigateTo(state.sourceId ? buildPulseWorkspaceHref({ baseId, state: { view: "sources", sourceId: state.sourceId } }) : listHref()),
    writeBlocked,
    refreshBaseData: async () => {
      await Promise.all([queries.baseData.invalidate(), queries.figures.invalidate()]);
      if (queries.baseData.error()) throw queries.baseData.error();
    },
    refreshSourceDetail: async () => {
      if (!selectedSourceId()) return;
      await queries.sourceDetail.invalidate();
      if (queries.sourceDetail.error()) throw queries.sourceDetail.error();
    },
  });

  const changeSearch = (value: string) => {
    setSearch(value);
    clearTimeout(settle);
    settle = setTimeout(() => setSettled(value.trim()), 250);
    if (isServer) return;
    const url = new URL(location.href);
    if (value.trim()) url.searchParams.set("q", value.trim());
    else url.searchParams.delete("q");
    history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  };
  const dismissRemovedNotice = () => {
    setRemovedNotice(false);
    const url = new URL(location.href);
    url.searchParams.delete("notice");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const openAdd = () => {
    if (controller.requireWritable()) setAdding(true);
  };
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const alerts = () => props.initialAttention?.alerts ?? [];

  return (
    <BaseFrame
      nav={props.initialNav}
      baseId={baseId}
      baseName={baseName()}
      view="sources"
      sourceCount={Math.max(props.sourceCount ?? 0, sources().length)}
      // A detail stands beside the list only while a source is open; without one the list has the whole width.
      detail={selected() ? 420 : undefined}
      more={[{ label: t().sqlAskAssistant, icon: "sparkles", disabled: assistantPending(), onClick: () => void askAssistant() }]}
      // an open source is its own page on the phone, without the list's floating "Neue Quelle"
      primary={selected() ? undefined : { label: t().newSource, icon: "plus", onClick: openAdd, disabled: loading() }}
      end={
        <>
          <Input
            type="search"
            icon="search"
            label={t().searchSourcesPlaceholder}
            placeholder={t().searchSourcesPlaceholder}
            value={search()}
            onInput={changeSearch}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search()) {
                event.preventDefault();
                changeSearch("");
              }
            }}
          />
          <Button variant="primary" icon="plus" disabled={loading()} onClick={openAdd}>
            {t().newSource}
          </Button>
        </>
      }
    >
      <Pane.Split>
        <Pane
          label={words().sources}
          // beside an open source the list keeps a width of its own; alone it has the whole page
          width={selected() ? { min: 360, default: 720 } : undefined}
          scrollKey="pulse-sources"
          // a search says what it found; the base's state stands in the figures below
          status={
            search().trim() ? (
              <StatusRow
                // while new words are asked for, the old count stands as loading, not as the answer
                lead={words().matchesFound({ count: shown().length, more: queries.baseData.hasMore() })}
                loading={refreshing() || queries.baseData.stale()}
              />
            ) : undefined
          }
        >
          {/* a base without sources has nothing to sum: the empty list says what to do */}
          <Show when={!search().trim() && figures() && figures()!.total > 0 ? figures() : undefined}>
            {(all) => (
              <SourcesHero
                figures={all()}
                now={compactDate(props.initialNow, dateContext())}
                alerts={
                  alerts().length > 0
                    ? {
                        count: alerts().length,
                        name: alerts()[0]!.name,
                        critical: alerts().some((alert) => alert.severity === "critical" || alert.state === "error"),
                        href: buildPulseWorkspaceHref({ baseId, state: { view: "sources", alertId: alerts()[0]!.reference } }),
                      }
                    : undefined
                }
              />
            )}
          </Show>
          <Show when={removedNotice()}>
            <Notice
              tone="note"
              icon="info-circle"
              title={t().dashboardsRemovedTitle}
              actions={[{ label: t().dashboardsRemovedDismiss, onClick: dismissRemovedNotice }]}
            >
              {t().dashboardsRemovedDetail}
            </Notice>
          </Show>
          <Show when={store.down()}>
            <Notice
              tone="warn"
              icon="database-off"
              title={t().storeDownTitle}
              meta={
                storeDownSince() ? `${t().storeDownSince({ time: when(storeDownSince()!) })} · ${t().storeDownChecks}` : t().storeDownChecks
              }
            >
              {t().storeDownConsequence({ time: when(props.initialAttention?.readAt ?? props.initialNow) })}
            </Notice>
          </Show>
          <Show when={readError()}>
            {(error) => (
              <Notice
                tone="bad"
                icon="alert-circle"
                title={t().pulseDataRefreshFailed}
                actions={[
                  {
                    label: words().reload,
                    icon: "refresh",
                    onClick: () => void Promise.all(readQueries().map((query) => query.refresh())),
                  },
                ]}
              >
                {error().message}
              </Notice>
            )}
          </Show>
          {/* the alerts stand as one exception in the hero; their list with its deeds opens from there (and from an
              alert's notification), so it never stands as a block above the sources */}
          <Show when={alerts().length > 0 && props.initialRouteState.alertId}>
            <FiredAlerts
              alerts={alerts()}
              selected={props.initialRouteState.alertId}
              when={when}
              sqlHref={(alertId) => buildPulseWorkspaceHref({ baseId, state: { view: "sql", alertId } })}
              adjust={(alertId) => void adjustAlert(alertId)}
              pending={assistantPending()}
            />
          </Show>
          {/* k2b-ui gap: v2 Table does not virtualize yet (lane MW); a base holds at most a few hundred sources. */}
          <Table
            label={words().sources}
            rows={shown()}
            rowKey={(source) => source.id}
            current={selectedSourceId() || undefined}
            open={(source) => ({ href: sourceHref(source) })}
            empty={
              sources().length === 0
                ? { icon: "database", text: t().noSources, action: { label: t().newSource, icon: "plus", onClick: openAdd } }
                : { icon: "search", text: words().noMatches, action: { label: words().clearSearch, onClick: () => changeSearch("") } }
            }
            phone={(source) => ({
              mark: sourceMark(source),
              lines: [source.name, phoneLine(source)],
            })}
            // identity B (study Pulse B): one line per source with its name, its state as dot and word, its fetches of the
            // last 30 minutes as the one column over time, and today's values. Kind, endpoint and last data stand in the
            // detail, and on the phone in the second line.
            columns={[
              {
                title: t().source,
                width: { min: 200, default: 240 },
                mark: sourceMark,
                cell: (source) => <Text weight="strong">{source.name}</Text>,
              },
              {
                title: words().sourceStatusColumn,
                width: { min: 130, default: 150 },
                cell: (source) => stateWord(source, t()),
              },
              // the fetches step aside while a source is open: its detail shows them per minute, and the list beside the
              // detail keeps its name, state and values whole down to 1024 (columns drop on the phone only, rule 7)
              ...(selected()
                ? []
                : [
                    {
                      title: words().fetchesColumn,
                      width: { min: 130, default: 140 },
                      drop: true,
                      // k2b-ui gap: Ticks (#4353); becomes <Ticks slots={source.fetches} label={…} /> once it is on main.
                      // Push sources record no fetches and leave the cell empty.
                      cell: (source: PulseSource) =>
                        source.fetches ? (
                          <Canvas label={words().fetchesOf({ name: source.name })}>
                            <FetchTicksDrawing slots={source.fetches} label={fetchesLabel(source.fetches)} />
                          </Canvas>
                        ) : (
                          ""
                        ),
                    },
                  ]),
              {
                title: words().dataColumn,
                align: "end",
                width: { min: 110, default: 124 },
                drop: true,
                // one figure for every kind of source, so the column compares like with like; none today is a dash
                cell: (source) => (source.todayCount ? number(source.todayCount) : "–"),
              },
            ]}
          />
          <Show when={queries.baseData.hasMore()}>
            <Bar
              start={
                <Text type="meta" muted>
                  {search().trim()
                    ? words().matchesFound({ count: shown().length, more: true })
                    : words().rowsShown({ shown: number(shown().length), total: number(figures()?.total ?? shown().length) })}
                </Text>
              }
              end={
                <Button icon="chevrons-down" busy={queries.baseData.loadingMore()} onClick={() => void queries.baseData.loadMore()}>
                  {words().loadMore}
                </Button>
              }
            />
          </Show>
        </Pane>
        <Show when={selected()} keyed>
          {(source) => (
            <SourceDetail
              source={source}
              origin={props.initialOrigin}
              when={when}
              clock={(value) => compactDate(value, dateContext())}
              loading={loading() || writeBlocked()}
              scrapes={queries.currentDetail()?.scrapes ?? []}
              minutes={queries.currentDetail()?.minutes ?? []}
              alerts={queries.currentDetail()?.alerts ?? []}
              history={queries.currentDetail()?.history ?? []}
              alertHref={(alertId) => buildPulseWorkspaceHref({ baseId, state: { view: "sql", alertId } })}
              now={props.initialNow}
              timeZone={dateContext().timeZone}
              apiKeys={queries.currentDetail()?.apiKeys ?? []}
              closeHref={listHref()}
              edit={() => {
                if (controller.requireWritable()) setEditing(source);
              }}
              toggle={() => void controller.toggleSource(source)}
              scrape={() => void controller.scrape(source)}
              remove={() => void controller.removeSource(source)}
              createKey={(input) => controller.createApiKey(source, input)}
              revokeKey={(credentialId) => controller.revokeApiKey(source, credentialId)}
              copy={(text) =>
                void clipboard.copy(text).then(
                  () => toast(t().commandCopied, { status: "ok" }),
                  () => toast(t().copySetupFailed, { status: "bad" }),
                )
              }
            />
          )}
        </Show>
      </Pane.Split>
      <NewSourceDialog
        open={adding()}
        onOpenChange={setAdding}
        baseName={baseName()}
        timezone={base()?.timezone ?? "UTC"}
        create={controller.createSource}
        inspect={() => navigateTo(listHref())}
      />
      <EditSourceDialog
        source={editing()}
        onClose={() => setEditing(null)}
        timezone={base()?.timezone ?? "UTC"}
        save={controller.saveSource}
      />
    </BaseFrame>
  );
}

/**
 * Fired alerts and alerts that cannot be checked, above the sources; the server orders them and sends at most 50.
 * A row opens the alert's SQL; "Adjust with Gustav" is its one deed.
 */
function FiredAlerts(props: {
  alerts: AlertAttention[];
  selected?: string;
  when: (value: string) => string;
  sqlHref: (alertId: string) => string;
  adjust: (alertId: string) => void;
  pending: boolean;
}) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const title = (alert: AlertAttention) =>
    alert.state === "firing"
      ? t().alertFired({ name: alert.name })
      : alert.state === "error"
        ? t().alertCannotCheck({ name: alert.name })
        : t().alertNoData({ name: alert.name });
  const condition = (alert: AlertAttention) =>
    alert.threshold === null
      ? alert.errorCode
        ? t().alertCheckFailed({ code: alert.errorCode })
        : ""
      : t().alertConditionWords({ comparison: alert.comparison, threshold: String(alert.threshold) });
  const since = (alert: AlertAttention) => {
    const time = props.when(alert.since);
    return alert.value === null ? t().storeDownSince({ time }) : t().alertSinceValue({ since: time, value: String(alert.value) });
  };
  return (
    <Section icon="bell-ringing" title={words().alertsTitle} count={props.alerts.length}>
      <List label={words().alertsTitle}>
        <For each={props.alerts}>
          {(alert) => (
            <Row
              icon={alert.state === "firing" ? "alert-triangle" : "help-circle"}
              lines={[title(alert), [condition(alert), since(alert)].filter(Boolean).join(" · ")]}
              current={props.selected === alert.reference}
              href={props.sqlHref(alert.reference)}
              end={
                <>
                  {alert.state === "firing" ? (
                    <Chip status={alert.severity === "critical" ? "bad" : "warn"}>
                      {alert.severity === "critical" ? t().severityCritical : t().severityWarning}
                    </Chip>
                  ) : (
                    <Chip status="warn">{alert.state === "error" ? t().error : t().noDataYet}</Chip>
                  )}
                  {/* the deed is the same on every alarm, so it waits behind the row's "…" */}
                  <Menu
                    label={`${t().adjustWithGustav}: ${alert.name}`}
                    disabled={props.pending}
                    items={[{ label: t().adjustWithGustav, icon: "sparkles", onClick: () => props.adjust(alert.reference) }]}
                  />
                </>
              }
            />
          )}
        </For>
      </List>
    </Section>
  );
}

/** The open source beside the list; on the phone it is the page, with the way back to the list. */
function SourceDetail(props: {
  source: PulseSource;
  origin: string;
  when: (value: string) => string;
  /** A time as its clock time only, such as the start of a run of fetches. */
  clock: (value: string) => string;
  loading: boolean;
  scrapes: import("../../contracts").PulseSourceScrape[];
  apiKeys: import("@k2b/cloud/access/ui").ResourceApiKey[];
  /** A metrics source's last hour per minute, oldest first. */
  minutes: FetchMinute[];
  /** The alert rules that concern the source, firing first. */
  alerts: SourceAlert[];
  /** What happened to the source, newest first. */
  history: SourceEvent[];
  /** Where an alert opens: its SQL in the console. */
  alertHref: (alertId: string) => string;
  /** Now, for the hour's end. */
  now: string;
  /** The base's zone, in which the fetches' times stand. */
  timeZone?: string;
  closeHref: string;
  edit: () => void;
  toggle: () => void;
  scrape: () => void;
  remove: () => void;
  createKey: Parameters<typeof ResourceApiKeySection>[0]["createKey"];
  revokeKey: Parameters<typeof ResourceApiKeySection>[0]["revokeKey"];
  copy: (text: string) => void;
}) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const cloudId = useCloudIdCopy();
  const source = () => props.source;
  const status = () => source().status;
  const command = () => curlExample(props.origin);
  const [connecting, setConnecting] = createSignal(false);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  // what the source is, in one line: its kind, how often it is read, how many series it fills
  const metaLine = () =>
    [
      source().kind === "metrics" ? t().metricsEndpoint : t().httpIngest,
      source().kind === "metrics" ? t().scrapeEvery({ seconds: source().scrapeIntervalSeconds ?? 60 }) : "",
      words().seriesShort({ count: number(source().seriesCount ?? 0) }),
      !status().lastError && status().newestDataAt ? words().lastValuesAt({ time: props.when(status().newestDataAt!) }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  // one entry of the history as a sentence: who did what, or what happened by itself
  const historyLine = (event: SourceEvent) =>
    event.kind === "stale"
      ? words().historyStale
      : event.kind === "fresh"
        ? words().historyFresh
        : event.kind === "created"
          ? words().historyCreated({ name: event.actor?.name ?? words().someone })
          : words().historyUpdated({ name: event.actor?.name ?? words().someone });
  // an alert's state in words: when it fired, since when it has no data or cannot be checked, or that it is quiet
  const alertLine = (alert: SourceAlert) => {
    const since = alert.since ? props.when(alert.since) : "";
    return alert.state === "firing"
      ? words().alertFiredAt({ time: since })
      : alert.state === "no_data"
        ? words().alertNoDataSince({ time: since })
        : alert.state === "error"
          ? words().alertErrorSince({ time: since })
          : alert.state === "pending"
            ? words().alertPending
            : words().alertQuiet;
  };
  // the failures at the head of the fetches, newest first, that end now
  const failedInARow = () => {
    let count = 0;
    for (const scrape of props.scrapes) {
      if (scrape.success) break;
      count += 1;
    }
    return count;
  };
  const hourStart = () => props.clock(new Date(Date.parse(props.now) - (props.minutes.length - 1) * 60_000).toISOString());
  const hourLabel = () =>
    words().hourLabel({
      values: number(props.minutes.reduce((sum, minute) => sum + minute.values, 0)),
      failed: number(props.minutes.filter((minute) => minute.slot === "bad").length),
    });
  // the newest fetches one per line: when, what came or why not, how long it took
  const logRows = () =>
    props.scrapes.slice(0, 5).map((scrape) => ({
      time: new Intl.DateTimeFormat(locale(), {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: props.timeZone,
      }).format(new Date(scrape.startedAt)),
      failed: !scrape.success,
      result: scrape.success ? words().metricsCount({ count: number(scrape.metrics) }) : shortError(scrape.errorMessage),
      duration:
        scrape.durationMs >= 1000
          ? `${new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(scrape.durationMs / 1000)} s`
          : `${number(scrape.durationMs)} ms`,
    }));
  const shortError = (message: string | null) =>
    !message
      ? words().failedShort
      : /timed out/.test(message)
        ? words().timeoutShort
        : (/returned HTTP (\d{3})/.exec(message)?.[1] ?? null)
          ? `HTTP ${/returned HTTP (\d{3})/.exec(message)![1]}`
          : words().failedShort;
  const deeds = (): MenuEntry[] => [
    { label: t().edit, icon: "pencil", disabled: props.loading, onClick: props.edit },
    {
      label: source().enabled ? t().pause : t().resume,
      icon: source().enabled ? "player-pause" : "player-play",
      disabled: props.loading,
      onClick: props.toggle,
    },
    ...(cloudId.available()
      ? [
          {
            label: cloudIdMessages.resolve([locale()]).t.copy,
            icon: "link",
            onClick: () => cloudId.copy({ type: "pulse.source", id: source().id }),
          },
        ]
      : []),
    { label: t().removeSource, icon: "trash", danger: true, disabled: props.loading, onClick: props.remove },
  ];
  // the keys the connect dialog creates or revokes count in the settings fact at once
  const [keys, setKeys] = createSignal(props.apiKeys);
  createEffect(on(() => props.apiKeys, setKeys, { defer: true }));
  const createKey: Parameters<typeof ResourceApiKeySection>[0]["createKey"] = async (input) => {
    const created = await props.createKey(input);
    setKeys((current) => [created.credential, ...current]);
    return created;
  };
  const revokeKey: Parameters<typeof ResourceApiKeySection>[0]["revokeKey"] = async (credentialId) => {
    await props.revokeKey(credentialId);
    setKeys((current) => current.filter((key) => key.id !== credentialId));
  };
  const activeKeys = () =>
    keys().filter((key) => !key.revokedAt && (!key.expiresAt || Date.parse(key.expiresAt) > Date.parse(props.now))).length;
  const facts = () => [
    { label: words().kindColumn, value: source().kind === "metrics" ? t().metricsEndpoint : t().httpIngest },
    ...(source().kind === "http_ingest" ? [{ label: words().keysLabel, value: words().activeKeys({ count: activeKeys() }) }] : []),
    {
      label: t().target,
      // an address breaks at its slashes like words, not sign by sign as a token would
      value: atSegments(source().kind === "metrics" ? (source().endpointUrl ?? t().noEndpoint) : `POST ${props.origin}/api/pulse/ingest`),
      copy: source().kind === "metrics" ? (source().endpointUrl ?? undefined) : `${props.origin}/api/pulse/ingest`,
    },
    ...(source().kind === "metrics"
      ? [
          { label: t().interval, value: t().scrapeEvery({ seconds: source().scrapeIntervalSeconds ?? 60 }) },
          {
            label: t().metricsKept,
            value: source().metricFilters.length ? source().metricFilters.join(", ") : t().allMetrics,
            mono: source().metricFilters.length > 0,
          },
        ]
      : []),
    ...(source().expectEverySeconds != null || source().expectDailyBy
      ? [
          {
            label: t().sourceExpectation,
            value: source().expectDailyBy
              ? `${t().sourceExpectationDaily} · ${source().expectDailyBy}`
              : `${t().sourceExpectationEvery} · ${source().expectEverySeconds} ${words().seconds}`,
          },
        ]
      : []),
    ...(status().refusedHistograms.length
      ? [
          {
            label: t().refusedHistograms,
            value: status()
              .refusedHistograms.map((item) => `${item.family} · ${t().refusedHistogramReason({ reason: item.reason })}`)
              .join("; "),
          },
        ]
      : []),
    ...(status().skippedSummaries
      ? [
          {
            label: t().skipped,
            value: t().skippedSummaries({
              count: status().skippedSummaries,
              shown: text.pprintNumber(status().skippedSummaries, { locale: locale() }),
            }),
          },
        ]
      : []),
    {
      label: words().created,
      value: new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(source().createdAt)),
    },
  ];
  return (
    <Pane
      detail
      label={source().name}
      scrollKey="pulse-source"
      back={{ label: words().backToSources, href: props.closeHref }}
      head={
        <Bar
          start={
            <Inline>
              <Mark {...sourceMark(source())} />
              <Text type="lead">{source().name}</Text>
            </Inline>
          }
          end={
            <>
              <Show when={source().kind === "metrics"}>
                <Button icon="refresh" keep disabled={props.loading || !source().enabled} onClick={props.scrape}>
                  {words().fetchNow}
                </Button>
              </Show>
              <Show when={source().kind === "http_ingest"}>
                <Button icon="plug-connected" keep onClick={() => setConnecting(true)}>
                  {words().connect}
                </Button>
              </Show>
              <Menu label={t().moreSourceActions} items={deeds()} />
              <Button variant="ghost" icon="x" label={t().closeSourceDetails} href={props.closeHref} />
            </>
          }
        />
      }
    >
      {/* the head of the open source (identity B): what it is in one line and, when it fails, the cause in red right
          there; it becomes the tinted object head once @k2b/ui has it */}
      <Band label={source().name}>
        <Text muted>{metaLine()}</Text>
        <Show when={status().lastError}>
          {(error) => (
            <>
              <Text tone="bad" weight="medium">
                {status().lastErrorAt ? words().noValuesSince({ time: props.clock(status().lastErrorAt!) }) : words().fetchFailing}
              </Text>
              <Text tone="bad" type="meta">
                {[localizedSourceError(error(), t()), failedInARow() > 1 ? words().inARow({ count: failedInARow() }) : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </>
          )}
        </Show>
      </Band>
      <Show when={status().throttled}>
        <Notice tone="warn" icon="gauge" title={t().throttled}>
          {t().throttledDetail}
        </Notice>
      </Show>
      <Show when={source().kind === "metrics" && props.minutes.length > 0}>
        <Section title={words().valuesPerMinute} count={words().lastHourWord}>
          <Canvas label={words().valuesPerMinute}>
            <SourceHourDrawing
              minutes={props.minutes}
              start={hourStart()}
              middle={words().fetchesWord}
              end={props.clock(props.now)}
              label={hourLabel()}
            />
          </Canvas>
        </Section>
      </Show>
      {/* the rules that concern this source (identity B): firing ones first, each opening its SQL */}
      <Show when={props.alerts.length > 0}>
        <Section title={words().alertsWord} count={props.alerts.length}>
          <List label={words().alertsWord}>
            <For each={props.alerts}>
              {(alert) => (
                <Row
                  mark={
                    alert.state === "firing"
                      ? { icon: "bell-ringing", color: alert.severity === "critical" ? "#b91c1c" : "#b45309" }
                      : alert.state === "no_data" || alert.state === "error"
                        ? { icon: "bell-exclamation", color: "#b45309" }
                        : { icon: "bell", color: "var(--k2-muted)" }
                  }
                  lines={[alert.name, alertLine(alert)]}
                  strong={alert.state === "firing"}
                  href={props.alertHref(alert.id)}
                />
              )}
            </For>
          </List>
        </Section>
      </Show>
      <Show when={source().kind === "metrics"}>
        <Section title={words().scrapesTitle}>
          <Show when={props.scrapes.length > 0} fallback={<Empty icon="history" text={t().noScrapes} />}>
            <Canvas label={words().scrapesTitle}>
              <FetchLogDrawing rows={logRows()} label={words().scrapesTitle} />
            </Canvas>
          </Show>
        </Section>
      </Show>
      {/* connecting a push source is a flow of its own (rule g): numbered steps in a dialog the head opens;
          k2b-ui gap: no side sheet and no steps part yet, so the dialog carries the steps as numbered sections */}
      <Dialog
        title={words().connectTitle({ name: source().name })}
        open={connecting()}
        onOpenChange={setConnecting}
        foot={
          <Button variant="primary" onClick={() => setConnecting(false)}>
            {words().done}
          </Button>
        }
      >
        <ResourceApiKeySection
          title={words().connectStepKey}
          description={`${t().apiKeysDescription} ${t().bearerTokenHint}`}
          initialKeys={props.apiKeys}
          permissionOptions={[{ value: "write", label: t().ingest, description: t().ingestDescription }]}
          createKey={createKey}
          revokeKey={revokeKey}
        />
        <Section
          title={words().connectStepSend}
          summary={t().idempotencyHint}
          actions={[{ label: t().copy, icon: "copy", onClick: () => props.copy(command()) }]}
        >
          {/* k2b-ui gap: no code block in v2 yet; Prose renders the command as preformatted Markdown. */}
          <Prose markdown={`\`\`\`bash\n${command()}\n\`\`\``} />
        </Section>
        <Section title={words().connectStepCheck}>
          <Text>{words().connectCheckText}</Text>
        </Section>
      </Dialog>
      <Section title={words().sourceSettings}>
        <Facts items={facts()} />
      </Section>
      {/* who set the source up and changed it, and when it stopped or started delivering (study B: "Verlauf" last) */}
      <Show when={props.history.length > 0}>
        <Section title={words().historyTitle}>
          <List label={words().historyTitle}>
            <For each={props.history}>
              {(event) => (
                <Row
                  {...(event.actor
                    ? { avatar: { name: event.actor.name } }
                    : event.kind === "stale"
                      ? { mark: { icon: "plug-connected-x", color: "#b91c1c" } }
                      : { mark: { icon: "plug-connected", color: "var(--k2-muted)" } })}
                  lines={[historyLine(event), props.when(event.at)]}
                />
              )}
            </For>
          </List>
        </Section>
      </Show>
    </Pane>
  );
}
