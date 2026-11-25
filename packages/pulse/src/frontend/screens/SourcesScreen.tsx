import { ResourceApiKeySection } from "@k2b/cloud/access/ui";
import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { navigateTo } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Dialog,
  Empty,
  Facts,
  Input,
  List,
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
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import type { AlertRule } from "../../alert-contracts";
import type { PulseBaseRead, PulseSource } from "../../contracts";
import { localizedSourceError } from "../../messages";
import type { AlertAttention } from "../../service/base-attention";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { compactDateWithDelta, type PulseDateContext } from "../workspace/date-format";
import { installPeriodicRefresh } from "../workspace/periodic-refresh";
import { launchPulseOverviewAssistant, launchPulseSqlAssistant } from "../workspace/pulse-assistant-launch";
import { buildPulseWorkspaceHref } from "../workspace/routes";
import { createSourceController } from "../workspace/source-controller";
import { sourceStatus } from "../workspace/source-helpers";
import { installStoreRecheck } from "../workspace/store-recheck";
import type { PulseWorkspaceProps } from "../workspace/types";
import { createPulseWorkspaceQueries } from "../workspace/workspace-queries";
import BaseFrame, { baseHref } from "./BaseFrame";
import { useScreenMessages } from "./messages";
import { EditSourceDialog, NewSourceDialog } from "./SourceDialogs";

export type SourcesScreenProps = PulseWorkspaceProps & {
  /** `?q=`: the words the source list is filtered by. */
  initialSearch?: string;
};

type Words = ReturnType<ReturnType<typeof usePulseMessages>>;

const statusChip = (source: PulseSource, t: Words) => {
  const status = sourceStatus(source, t);
  const tone = { ok: "ok", warning: "warn", error: "bad", neutral: undefined } as const;
  const kind = tone[status.tone];
  return kind ? <Chip status={kind}>{status.label}</Chip> : <Chip>{status.label}</Chip>;
};

const sourceLine = (source: PulseSource, t: Words) =>
  source.kind === "metrics"
    ? [t.metricsEndpoint, t.scrapeEvery({ seconds: source.scrapeIntervalSeconds ?? 60 }), source.endpointUrl ?? t.noEndpointShort].join(
        " · ",
      )
    : `${t.httpIngest} · ${t.tokenIngestEndpoint}`;

const dataCount = (source: PulseSource, t: Words) =>
  source.kind === "metrics"
    ? t.sqlSeriesCount({ count: source.seriesCount ?? 0 })
    : source.todayCount == null
      ? "—"
      : t.sqlTodayCount({ count: source.todayCount });

const PAGE = 100;

const curlExample = (origin: string) => `curl -fsS -X POST ${origin}/api/pulse/ingest \\
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

  const queries = createPulseWorkspaceQueries(props, selectedSourceId, () => true);
  const bases = () => queries.bases.data() ?? props.initialBases;
  const sources = () => queries.baseData.data() ?? props.initialSources;
  const base = () => bases().find((entry) => entry.id === baseId) ?? null;
  const baseName = () => base()?.name ?? t().appName;
  const selected = () => sources().find((source) => source.id === selectedSourceId()) ?? null;
  const shown = createMemo(() => {
    const needle = search().trim().toLowerCase();
    return needle ? sources().filter((source) => source.name.toLowerCase().includes(needle)) : sources();
  });
  // k2b-ui gap: tables do not virtualize yet (lane MW); the list shows 100 rows at a time, so the page stays bounded.
  const [visible, setVisible] = createSignal(PAGE);
  const readQueries = () =>
    selectedSourceId() ? [queries.bases, queries.baseData, queries.sourceDetail] : [queries.bases, queries.baseData];
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
      await Promise.all([queries.baseData.refresh(), ...(selectedSourceId() ? [queries.sourceDetail.refresh()] : [])]);
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
      await Promise.all([queries.bases.refresh(), queries.baseData.refresh()]);
    },
  });
  const storeDownSince = () => store.since() ?? base()?.store.errorAt ?? null;
  // A base the person lost access to leaves; the next base they can open takes its place.
  createEffect(
    on(
      queries.bases.data,
      (next) => {
        if (next && !next.some((entry) => entry.id === baseId)) navigateTo(next[0] ? baseHref(next[0].id) : "/app/pulse");
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
  const sourceHref = (source: PulseSource) =>
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
      await queries.baseData.invalidate();
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
    setVisible(PAGE);
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
  const paused = () => sources().filter((source) => !source.enabled).length;
  const failing = () => sources().filter((source) => source.enabled && source.status.lastError).length;
  const alerts = () => props.initialAttention?.alerts ?? [];

  return (
    <BaseFrame
      bases={bases()}
      baseId={baseId}
      view="sources"
      sourceCount={sources().length}
      // A detail stands beside the list only while a source is open; without one the list has the whole width.
      detail={selected() ? 420 : undefined}
      more={[{ label: t().sqlAskAssistant, icon: "sparkles", disabled: assistantPending(), onClick: () => void askAssistant() }]}
      primary={{ label: t().newSource, icon: "plus", onClick: openAdd, disabled: loading() }}
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
          width={{ min: 360, default: 720 }}
          scrollKey="pulse-sources"
          status={
            <StatusRow
              lead={
                search().trim()
                  ? words().matchesCount({ count: shown().length, total: sources().length })
                  : words().sourcesCount({ count: sources().length })
              }
              loading={refreshing()}
              facts={[
                ...(failing() ? [{ value: failing(), after: words().failingAfter }] : []),
                ...(paused() ? [{ value: paused(), after: words().pausedAfter }] : []),
              ]}
            />
          }
        >
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
          <Show when={alerts().length > 0}>
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
            rows={shown().slice(0, visible())}
            rowKey={(source) => source.id}
            current={selectedSourceId() || undefined}
            open={(source) => ({ href: sourceHref(source) })}
            empty={
              sources().length === 0
                ? { icon: "database", text: t().noSources, action: { label: t().newSource, icon: "plus", onClick: openAdd } }
                : { icon: "search", text: words().noMatches, action: { label: words().clearSearch, onClick: () => changeSearch("") } }
            }
            phone={(source) => ({
              lines: [
                source.name,
                `${sourceStatus(source, t()).label} · ${source.status.newestDataAt ? when(source.status.newestDataAt) : t().noDataYet}`,
              ],
            })}
            columns={[
              {
                title: t().source,
                width: { min: 180, default: 250 },
                cell: (source) => ({ lines: [source.name, sourceLine(source, t())] }),
              },
              { title: words().sourceStatusColumn, width: { min: 110, default: 120 }, cell: (source) => statusChip(source, t()) },
              {
                title: words().newestColumn,
                width: { min: 140, default: 160 },
                drop: true,
                cell: (source) => (source.status.newestDataAt ? when(source.status.newestDataAt) : t().noDataYet),
              },
              { title: words().dataColumn, align: "end", drop: true, cell: (source) => dataCount(source, t()) },
            ]}
          />
          <Show when={shown().length > visible()}>
            <Bar
              start={
                <Text type="meta" muted>
                  {words().rowsShown({ shown: String(visible()), total: String(shown().length) })}
                </Text>
              }
              end={
                <Button icon="chevrons-down" onClick={() => setVisible(visible() + PAGE)}>
                  {words().showMore}
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
              loading={loading() || writeBlocked()}
              scrapes={queries.currentDetail()?.scrapes ?? []}
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
                alert.state === "firing" ? (
                  <Chip status={alert.severity === "critical" ? "bad" : "warn"}>
                    {alert.severity === "critical" ? t().severityCritical : t().severityWarning}
                  </Chip>
                ) : (
                  <Chip>{alert.state === "error" ? t().error : t().noDataYet}</Chip>
                )
              }
              action={{
                label: t().adjustWithGustav,
                icon: "sparkles",
                disabled: props.pending,
                onClick: () => props.adjust(alert.reference),
              }}
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
  loading: boolean;
  scrapes: import("../../contracts").PulseSourceScrape[];
  apiKeys: import("@k2b/cloud/access/ui").ResourceApiKey[];
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
  const deeds = (): MenuEntry[] => [
    {
      label: source().enabled ? t().pause : t().resume,
      icon: source().enabled ? "player-pause" : "player-play",
      disabled: props.loading,
      onClick: props.toggle,
    },
    ...(source().kind === "metrics"
      ? [{ label: t().scrape, icon: "refresh", disabled: props.loading || !source().enabled, onClick: props.scrape }]
      : []),
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
  const facts = () => [
    {
      label: t().target,
      value: source().kind === "metrics" ? (source().endpointUrl ?? t().noEndpoint) : `POST ${props.origin}/api/pulse/ingest`,
      mono: true,
      copy: source().kind === "metrics" ? (source().endpointUrl ?? undefined) : `${props.origin}/api/pulse/ingest`,
    },
    { label: words().sourceStatusColumn, value: statusChip(source(), t()) },
    { label: t().newestData, value: status().newestDataAt ? props.when(status().newestDataAt!) : t().noDataYet },
    { label: t().lastSeen, value: source().lastSeenAt ? props.when(source().lastSeenAt!) : t().waiting },
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
    ...(status().skippedSummaries ? [{ label: t().skipped, value: t().skippedSummaries({ count: status().skippedSummaries }) }] : []),
  ];
  return (
    <Pane
      detail
      label={source().name}
      scrollKey="pulse-source"
      back={{ label: words().backToSources, href: props.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{source().name}</Text>}
          end={
            <>
              <Button icon="pencil" keep disabled={props.loading} onClick={props.edit}>
                {t().edit}
              </Button>
              <Menu label={t().moreSourceActions} items={deeds()} />
              <Button variant="ghost" icon="x" label={t().closeSourceDetails} href={props.closeHref} />
            </>
          }
        />
      }
    >
      <Show when={status().lastError}>
        {(error) => (
          <Notice
            tone="bad"
            icon="alert-circle"
            title={t().error}
            meta={status().lastErrorAt ? props.when(status().lastErrorAt!) : undefined}
          >
            {localizedSourceError(error(), t())}
          </Notice>
        )}
      </Show>
      <Show when={status().throttled}>
        <Notice tone="warn" icon="gauge" title={t().throttled}>
          {t().throttledDetail}
        </Notice>
      </Show>
      <Section icon="info-circle" title={t().properties} summary={source().kind === "metrics" ? t().metricsEndpoint : t().httpIngest}>
        <Facts items={facts()} />
      </Section>
      <Show when={source().kind === "http_ingest"}>
        <ResourceApiKeySection
          title={t().apiKeys}
          description={`${t().apiKeysDescription} ${t().bearerTokenHint}`}
          initialKeys={props.apiKeys}
          permissionOptions={[{ value: "write", label: t().ingest, description: t().ingestDescription }]}
          createKey={props.createKey}
          revokeKey={props.revokeKey}
        />
        <Section
          icon="send"
          title={words().setupTitle}
          summary={t().idempotencyHint}
          actions={[{ label: t().copy, icon: "copy", onClick: () => props.copy(command()) }]}
        >
          {/* k2b-ui gap: no code block in v2 yet; Prose renders the command as preformatted Markdown. */}
          <Prose markdown={`\`\`\`bash\n${command()}\n\`\`\``} />
        </Section>
      </Show>
      <Show when={source().kind === "metrics"}>
        <Section icon="history" title={words().scrapesTitle} count={props.scrapes.length || undefined}>
          <Show when={props.scrapes.length > 0} fallback={<Empty icon="history" text={t().noScrapes} />}>
            <List label={words().scrapesTitle}>
              <For each={props.scrapes}>
                {(scrape) => (
                  <Row
                    icon={scrape.success ? "circle-check" : "alert-circle"}
                    lines={[
                      scrape.success ? `${t().success} · ${t().ingestCounts(scrape)}` : t().error,
                      scrape.errorMessage
                        ? (localizedSourceError(scrape.errorMessage, t()) ?? scrape.errorMessage)
                        : `${scrape.durationMs} ms`,
                    ]}
                    time={props.when(scrape.finishedAt)}
                  />
                )}
              </For>
            </List>
          </Show>
        </Section>
      </Show>
    </Pane>
  );
}
