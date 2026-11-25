import type { PulseBase, PulseSource, PulseSourceScrape } from "../../contracts";
import type { BaseAttention } from "../../service/base-attention";
import type { SavedQuery } from "../../service/saved-queries";
import type { BaseStoreStatus } from "../../store/admin-contracts";
import type { SourcesScreenProps } from "./SourcesScreen";

/** Invented data for the v2 screens' tests and previews: no real names, hosts or values. */
export const FIXTURE_NOW = "2026-11-25T09:42:00.000Z";

const store = (patch: Partial<BaseStoreStatus> = {}): BaseStoreStatus => ({
  state: "active",
  operation: null,
  errorCode: null,
  errorAt: null,
  writeBlockReason: null,
  profile: "normal",
  limits: {
    valuesPerMinute: 60_000,
    bytesPerMinute: 8 * 1024 ** 2,
    maxSeries: 50_000,
    maxEventKinds: 500,
    maxStateKeys: 2_000,
    queriesPerHour: 600,
    storageBytes: 20 * 1024 ** 3,
  },
  usage: { bytes: 3.2 * 1024 ** 3, rows: 48_000_000, measuredAt: FIXTURE_NOW },
  ...patch,
});

export const fixtureBase = (patch: Partial<PulseBase> & Pick<PulseBase, "id" | "name">): PulseBase => ({
  memberCount: 4,
  store: store(),
  description: null,
  shortId: patch.id,
  icon: "ti ti-activity",
  color: "blue",
  timezone: "Europe/Berlin",
  rawRetentionDays: 30,
  rollupRetentionDays: 400,
  sensitiveRetentionHours: 72,
  createdBy: null,
  deletionStartedAt: null,
  deletionFailedAt: null,
  deletionError: null,
  dataClearStartedAt: null,
  dataClearCompletedAt: null,
  dataClearFailedAt: null,
  dataClearError: null,
  createdAt: "2026-03-02T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  ...patch,
});

export const fixtureBases: PulseBase[] = [
  fixtureBase({ id: "b7Kq2mX9", name: "Betrieb Werkstatt Nord", description: "Server, Netz und Drucker der Werkstatt", memberCount: 6 }),
  fixtureBase({ id: "c3Lw8pR1", name: "Webshop", description: "Bestellungen, Zahlungen und Antwortzeiten", rawRetentionDays: 90 }),
  fixtureBase({ id: "d5Nz4tH6", name: "Solaranlage Lager", description: null, memberCount: 2, store: store({ state: "provisioning" }) }),
  fixtureBase({
    id: "e8Pv1sJ3",
    name: "Archiv 2025",
    description: "Alte Messwerte, nur lesend",
    memberCount: 1,
    store: store({ writeBlockReason: "checkpoint_mismatch" }),
  }),
];

export const fixtureDeletingBases: PulseBase[] = [
  fixtureBase({
    id: "f2Qr7uK4",
    name: "Testbasis Herbst",
    store: store({ state: "deleting" }),
    deletionStartedAt: "2026-11-25T09:30:00.000Z",
  }),
  fixtureBase({
    id: "g6Ts3vL8",
    name: "Altes Lager",
    store: store({ state: "failed", errorCode: "STORE_UNREACHABLE", errorAt: "2026-11-25T08:10:00.000Z" }),
    deletionFailedAt: "2026-11-25T08:10:00.000Z",
  }),
];

/** Worst cases for break-ui: long and unbreakable names, non-Latin text, emoji, huge counts, a one-letter name. */
export const worstBases: PulseBase[] = [
  fixtureBase({
    id: "h1Uw5xM2",
    name: "Betriebsüberwachung der Produktionsstraßen Nord-Ost einschließlich aller Nebengebäude und Außenstellen",
    description:
      "Sehr lange Beschreibung ohne Punkt und Komma die einfach immer weiter geht und niemals aufhört weil jemand alles hineingeschrieben hat",
    memberCount: 12_345,
    rawRetentionDays: 3650,
  }),
  fixtureBase({ id: "i4Vx9yN5", name: "A", description: null, memberCount: 0 }),
  fixtureBase({
    id: "j7Wy2zP8",
    name: "https://telemetrie.sehr-lange-domain-ohne-umbruch.example/werkstatt/nord",
    description: "⚡️🔥📈 Messwerte",
  }),
  fixtureBase({ id: "k0Xz6aQ1", name: "東京オフィスの監視", description: "サーバーとネットワーク", store: store({ state: "failed" }) }),
];

export const manyBases = (count: number): PulseBase[] =>
  Array.from({ length: count }, (_, index) =>
    fixtureBase({ id: `m${String(index).padStart(7, "0")}`, name: `Basis ${index + 1}`, description: `Messwerte Standort ${index + 1}` }),
  );

const status = (patch: Partial<PulseSource["status"]> = {}): PulseSource["status"] => ({
  newestDataAt: "2026-11-25T09:41:00.000Z",
  throttled: false,
  throttledAt: null,
  refusedHistograms: [],
  skippedSummaries: 0,
  lastError: null,
  lastErrorAt: null,
  ...patch,
});

export const fixtureSource = (patch: Partial<PulseSource> & Pick<PulseSource, "id" | "name">): PulseSource => ({
  baseId: "b7Kq2mX9",
  kind: "metrics",
  enabled: true,
  endpointUrl: "https://node-exporter.werkstatt.example:9100/metrics",
  bearerTokenConfigured: false,
  scrapeIntervalSeconds: 60,
  metricFilters: [],
  revision: 1,
  expectEverySeconds: null,
  expectDailyBy: null,
  staleSince: null,
  status: status(),
  seriesCount: 1_284,
  lastSeenAt: "2026-11-25T09:41:00.000Z",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-03-02T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  ...patch,
});

export const fixtureSources: PulseSource[] = [
  fixtureSource({ id: "s1Aa2Bb3", name: "Server Werkstatt" }),
  fixtureSource({
    id: "s4Cc5Dd6",
    name: "Webshop-Ereignisse",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    seriesCount: undefined,
    todayCount: 4_812,
  }),
  fixtureSource({
    id: "s7Ee8Ff9",
    name: "Drucker Halle 2",
    endpointUrl: "http://10.0.0.12:9100/metrics",
    status: status({ newestDataAt: "2026-11-24T17:20:00.000Z", lastError: "SCRAPE_TIMEOUT", lastErrorAt: "2026-11-25T09:40:00.000Z" }),
    lastError: "SCRAPE_TIMEOUT",
  }),
  fixtureSource({ id: "s0Gg1Hh2", name: "Wechselrichter", enabled: false, seriesCount: 42 }),
];

export const fixtureScrapes: PulseSourceScrape[] = [
  {
    id: "r1",
    sourceId: "s1Aa2Bb3",
    startedAt: "2026-11-25T09:41:00.000Z",
    finishedAt: "2026-11-25T09:41:01.000Z",
    durationMs: 412,
    success: true,
    metrics: 1_284,
    events: 0,
    states: 0,
    errorMessage: null,
  },
  {
    id: "r2",
    sourceId: "s1Aa2Bb3",
    startedAt: "2026-11-25T09:40:00.000Z",
    finishedAt: "2026-11-25T09:40:01.000Z",
    durationMs: 398,
    success: true,
    metrics: 1_280,
    events: 0,
    states: 0,
    errorMessage: null,
  },
];

/** The page props of a base on Sources, as the server builds them, from the invented data above. */
export const sourcesProps = (
  options: { open?: string; sources?: PulseSource[]; alerts?: BaseAttention["alerts"]; storeDown?: boolean } = {},
): SourcesScreenProps => {
  const sources = options.sources ?? fixtureSources;
  const open = options.open ?? "";
  return {
    initialBases: fixtureBases,
    initialBaseId: fixtureBases[0]!.id,
    initialRouteState: { view: "sources", sourceId: open },
    initialSources: sources,
    initialSettings: { maxRawRetentionDays: 365, admins: ["Jana Petersen"] },
    initialPermissions: { write: true, admin: true },
    initialAttention: {
      readAt: FIXTURE_NOW,
      store: { unavailable: options.storeDown ?? false, since: options.storeDown ? "2026-11-25T09:20:00.000Z" : null },
      alerts: options.alerts ?? fixtureAlerts,
    },
    initialSourceScrapes: open ? { [open]: fixtureScrapes } : {},
    initialSourceApiKeys: {},
    initialQueryCoverage: { bases: true, baseData: true, sourceDetail: true },
    initialDateConfig: { timeZone: "Europe/Berlin", locale: "de", firstDayOfWeek: 1 },
    initialNow: FIXTURE_NOW,
    initialOrigin: "https://cloud.example.test",
  };
};

export const fixtureAlerts: BaseAttention["alerts"] = [
  {
    reference: "al1Xy9Zq",
    name: "CPU Werkstatt",
    state: "firing",
    severity: "critical",
    since: "2026-11-25T09:12:00.000Z",
    lastCheckedAt: FIXTURE_NOW,
    errorCode: null,
    key: "host=srv-1",
    value: 97,
    comparison: "above",
    threshold: 90,
  },
  {
    reference: "al2Wv8Yp",
    name: "Bestellungen pro Stunde",
    state: "no_data",
    severity: null,
    since: "2026-11-25T07:00:00.000Z",
    lastCheckedAt: FIXTURE_NOW,
    errorCode: null,
    key: null,
    value: null,
    comparison: "below",
    threshold: 5,
  },
];

export const fixtureQueries: SavedQuery[] = [
  {
    id: "q1Ab2Cd3",
    baseId: "b7Kq2mX9",
    name: "CPU pro Host, letzte Stunde",
    sql: "-- Last of every host\nSELECT toStartOfMinute(ts) AS time, host, avg(value) AS cpu\nFROM samples\nWHERE name = :metric\nGROUP BY time, host",
    params: { metric: "node_cpu" },
    revision: 3,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-24T16:20:00.000Z",
  },
  {
    id: "q4Ef5Gh6",
    baseId: "b7Kq2mX9",
    name: "Bestellungen pro Tag",
    sql: "SELECT toDate(ts) AS day, count() FROM events WHERE kind = 'order.created' GROUP BY day",
    params: {},
    revision: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-10-12T08:00:00.000Z",
    updatedAt: "2026-11-20T09:00:00.000Z",
  },
];

/** Worst-case sources for break-ui: long and unbreakable names and endpoints, non-Latin text, emoji, huge counts. */
export const worstSources: PulseSource[] = [
  fixtureSource({
    id: "w1Aa2Bb3",
    name: "Produktionsstraße Nord-Ost Halle 7 Schaltschrank 12 Temperatur- und Feuchtigkeitssensoren aller Etagen",
    endpointUrl: "https://sehr-lange-subdomain-ohne-umbruch.werkstatt-nord-ost.example:9100/metrics/federate/node-exporter",
    seriesCount: 9_876_543,
    status: status({
      lastError: "SCRAPE_HTTP_STATUS:503",
      lastErrorAt: "2026-11-25T09:40:00.000Z",
      throttled: true,
      refusedHistograms: [{ family: "http_request_duration_seconds_bucket_sehr_lang", reason: "too_many_buckets" }],
      skippedSummaries: 12_345,
    }),
    metricFilters: ["node_cpu_seconds_total", "node_filesystem_avail_bytes", "node_network_receive_bytes_total"],
  }),
  fixtureSource({
    id: "w4Cc5Dd6",
    name: "東京オフィス 🔥📈",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    seriesCount: undefined,
    todayCount: 123_456_789,
  }),
  fixtureSource({ id: "w7Ee8Ff9", name: "X", status: status({ newestDataAt: null }), lastSeenAt: null, seriesCount: 0 }),
];

/** A huge base for the scale check: `count` sources with invented names. */
export const manySources = (count: number): PulseSource[] =>
  Array.from({ length: count }, (_, index) =>
    fixtureSource({ id: `n${String(index).padStart(7, "0")}`, name: `Quelle ${index + 1}`, seriesCount: index * 7 }),
  );
