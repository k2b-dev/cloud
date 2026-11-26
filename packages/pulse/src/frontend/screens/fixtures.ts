import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import {
  FETCH_BUCKET_MINUTES,
  FETCH_TICKS,
  type FetchesToday,
  type FetchMinute,
  type FetchSlot,
  type PulseBase,
  type PulseSource,
  type PulseSourceScrape,
  SOURCE_HOUR_MINUTES,
  type SourceFigures,
} from "../../contracts";
import type { BaseAttention } from "../../service/base-attention";
import type { SavedQuery } from "../../service/saved-queries";
import type { BaseStoreStatus } from "../../store/admin-contracts";
import { SOURCES_PAGE } from "../workspace/source-page";
import type { QueryAuthor } from "./QueriesScreen";
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

/** The words the metrics scraper writes when an endpoint does not answer in time. */
const TIMEOUT = "Metrics scrape timed out after 15 seconds";

/** Invented people who work in the bases, admins first. */
const PEOPLE = ["Jana Petersen", "Jonas Wolf", "Mira Aydın", "Ole Brandt", "Lea Sommer"];

export const fixtureBase = (patch: Partial<PulseBase> & Pick<PulseBase, "id" | "name">): PulseBase => ({
  memberCount: 4,
  // storage differs from base to base, as real bases fill at their own pace
  store: store({
    usage: { bytes: (((patch.id.charCodeAt(1) || 0) % 17) + 1) * 0.81 * 1024 ** 3, rows: 9_000_000, measuredAt: FIXTURE_NOW },
  }),
  // a base's first three members as an admin of it reads them, admins first; rotated so the bases differ
  members: [...PEOPLE.slice(patch.id.charCodeAt(0) % 5), ...PEOPLE].slice(0, Math.min(3, patch.memberCount ?? 4)).map((name, index) => ({
    principal: { type: "user" as const, userId: `00000000-0000-4000-9000-00000000000${PEOPLE.indexOf(name)}` },
    permission: index === 0 ? ("admin" as const) : ("write" as const),
    displayName: name,
  })),
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
  fixtureBase({
    id: "b7Kq2mX9",
    name: "Betrieb Werkstatt Nord",
    description: "Server, Netz und Drucker der Werkstatt",
    memberCount: 6,
    icon: "ti ti-server",
  }),
  fixtureBase({
    id: "c3Lw8pR1",
    store: store({ usage: { bytes: 13.6 * 1024 ** 3, rows: 12_000_000, measuredAt: FIXTURE_NOW } }),
    name: "Webshop",
    description: "Bestellungen, Zahlungen und Antwortzeiten",
    rawRetentionDays: 90,
    icon: "ti ti-shopping-cart",
    color: "emerald",
  }),
  fixtureBase({
    id: "d5Nz4tH6",
    name: "Solaranlage Lager",
    description: null,
    memberCount: 2,
    store: store({ state: "provisioning" }),
    icon: "ti ti-plug",
    color: "amber",
  }),
  fixtureBase({
    id: "h1Wm5xN2",
    store: store({ usage: { bytes: 2.1 * 1024 ** 3, rows: 12_000_000, measuredAt: FIXTURE_NOW } }),
    name: "Fuhrpark",
    description: "Standorte und Ladestand der Lieferwagen",
    memberCount: 3,
    icon: "ti ti-car",
    color: "red",
  }),
  fixtureBase({
    id: "j4Yb9zP7",
    store: store({ usage: { bytes: 8.9 * 1024 ** 3, rows: 12_000_000, measuredAt: FIXTURE_NOW } }),
    name: "WLAN Campus",
    description: "Zugangspunkte, Clients und Auslastung",
    memberCount: 5,
    icon: "ti ti-wifi",
  }),
  fixtureBase({
    id: "k8Cd2eQ5",
    store: store({ usage: { bytes: 0.7 * 1024 ** 3, rows: 12_000_000, measuredAt: FIXTURE_NOW } }),
    name: "Druckerflotte",
    description: "Toner, Seiten und Störungen",
    memberCount: 2,
    icon: "ti ti-printer",
    color: "zinc",
  }),
  fixtureBase({
    id: "e8Pv1sJ3",
    name: "Archiv 2025",
    icon: "ti ti-archive",
    color: "zinc",
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

/**
 * A metrics source's last minutes of fetches as the list reads them: every minute fine, none while paused, every
 * minute failed while it fails (the printer has not answered since yesterday evening). Push sources record none.
 */
const fetchesOf = (source: PulseSource): PulseSource => {
  if (source.kind !== "metrics" || "fetches" in source) return source;
  const slot: FetchSlot = !source.enabled ? "none" : source.lastError ? "bad" : "ok";
  return { ...source, fetches: Array.from({ length: FETCH_TICKS }, () => slot) };
};

export const fixtureSource = (patch: Partial<PulseSource> & Pick<PulseSource, "id" | "name">): PulseSource =>
  fetchesOf(fixtureSource0(patch));

const fixtureSource0 = (patch: Partial<PulseSource> & Pick<PulseSource, "id" | "name">): PulseSource => ({
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
  todayCount: 712_480,
  lastSeenAt: "2026-11-25T09:41:00.000Z",
  lastError: null,
  lastErrorAt: null,
  createdAt: "2026-03-02T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  ...patch,
});

/**
 * The base's sources as the list reads them, problems first (as identity study B shows them): the printer fails since
 * 10:40 after a morning of values, the hall light is new and waits for its first values, the inverter is paused.
 */
export const fixtureSources: PulseSource[] = [
  fixtureSource({
    id: "s7Ee8Ff9",
    name: "Drucker Halle 2",
    endpointUrl: "http://10.0.0.12:9100/metrics",
    status: status({ newestDataAt: "2026-11-25T09:39:00.000Z", lastError: TIMEOUT, lastErrorAt: "2026-11-25T09:40:00.000Z" }),
    lastError: TIMEOUT,
    lastErrorAt: "2026-11-25T09:40:00.000Z",
    lastSeenAt: "2026-11-25T09:42:00.000Z",
    seriesCount: 86,
    todayCount: 55_040,
    // fine all morning, three timeouts since 10:40
    fetches: [...Array.from({ length: FETCH_TICKS - 3 }, (): FetchSlot => "ok"), "bad", "bad", "bad"],
  }),
  fixtureSource({
    id: "s5Hh6Ll7",
    name: "Hallenlicht",
    endpointUrl: "http://10.0.0.44:9100/metrics",
    status: status({ newestDataAt: null }),
    lastSeenAt: null,
    seriesCount: 0,
    todayCount: 0,
    createdAt: "2026-11-25T09:31:00.000Z",
    fetches: Array.from({ length: FETCH_TICKS }, (): FetchSlot => "none"),
  }),
  fixtureSource({
    id: "s0Gg1Hh2",
    name: "Wechselrichter",
    enabled: false,
    scrapeIntervalSeconds: 300,
    seriesCount: 212,
    todayCount: 0,
    // paused since yesterday, so its newest data are from then
    status: status({ newestDataAt: "2026-11-24T16:05:00.000Z" }),
    lastSeenAt: "2026-11-24T16:05:00.000Z",
  }),
  fixtureSource({
    id: "s3Jj4Kk5",
    name: "Switch Halle 1",
    endpointUrl: "https://switch-h1.werkstatt.example:9116/snmp",
    seriesCount: 2_184,
    todayCount: 1_402_560,
  }),
  fixtureSource({ id: "s1Aa2Bb3", name: "Server Werkstatt", seriesCount: 1_110, todayCount: 712_480 }),
  fixtureSource({
    id: "s9Nn0Pp1",
    name: "Kühlraum Sensoren",
    endpointUrl: "http://10.0.0.31:9100/metrics",
    seriesCount: 24,
    todayCount: 15_408,
  }),
  fixtureSource({
    id: "s4Cc5Dd6",
    name: "Webshop-Ereignisse",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    seriesCount: 38,
    todayCount: 4_812,
  }),
  fixtureSource({
    id: "s2Qq3Rr4",
    name: "Lagerverwaltung",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    seriesCount: 61,
    todayCount: 2_904,
  }),
  fixtureSource({
    id: "s6Ll7Mm8",
    name: "Zugangsportal",
    kind: "http_ingest",
    endpointUrl: null,
    scrapeIntervalSeconds: null,
    seriesCount: 9,
    todayCount: 318,
    lastSeenAt: "2026-11-25T09:28:00.000Z",
  }),
];

/**
 * A metrics source's last hour per minute, matching its state: the printer brought its 86 values every minute until
 * 10:39 and has timed out since 10:40; a paused or new source has none; the others bring theirs every minute.
 */
export const fixtureMinutesFor = (sourceId: string): FetchMinute[] => {
  const source = fixtureSources.find((item) => item.id === sourceId);
  if (!source || source.kind !== "metrics") return [];
  return Array.from({ length: SOURCE_HOUR_MINUTES }, (_, index): FetchMinute => {
    if (!source.enabled || (!source.lastError && !source.status.newestDataAt)) return { slot: "none", values: 0 };
    if (source.lastError && index >= SOURCE_HOUR_MINUTES - 3) return { slot: "bad", values: 0 };
    // a little real-looking wobble around the series count, the same on every render
    return { slot: "ok", values: (source.seriesCount ?? 0) + ((index * 7) % 5) - 2 };
  });
};

/** A source's last fetches, matching its state: the printer timed out at 10:40, 10:41 and 10:42; the others answer. */
export const fixtureScrapesFor = (sourceId: string): PulseSourceScrape[] => {
  const failing = sourceId === "s7Ee8Ff9";
  const at = (minute: number) => `2026-11-25T09:${String(minute).padStart(2, "0")}:00.000Z`;
  return [42, 41, 40, 39, 38].map((minute, index) => {
    const failed = failing && minute >= 40;
    return {
      id: `${sourceId}-r${index}`,
      sourceId,
      startedAt: at(minute),
      finishedAt: at(minute).replace(":00.000Z", failed ? ":15.000Z" : ":01.000Z"),
      durationMs: failed ? 15_000 : failing ? 588 + index * 4 : 412 - index * 7,
      success: !failed,
      metrics: failed ? 0 : failing ? 86 : 1_110,
      events: 0,
      states: 0,
      errorMessage: failed ? TIMEOUT : null,
    };
  });
};

/** The page props of a base on Sources, as the server builds them, from the invented data above. */
/** The key the shop's backend sends its events with, used a minute ago. */
export const fixtureApiKeys: ResourceApiKey[] = [
  {
    id: "00000000-0000-4000-8000-0000000000c1",
    serviceAccountId: "00000000-0000-4000-8000-0000000000c2",
    name: "Webshop-Backend",
    kind: "api_token",
    status: "active",
    tokenPrefix: "puls_7f3a",
    scopes: ["write"],
    expiresAt: "2027-02-23T23:59:59.000Z",
    lastUsedAt: "2026-11-25T09:40:00.000Z",
    createdBy: null,
    createdAt: "2026-09-12T08:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    permission: "write",
  },
];

/** The figures the server reads for a list of sources: the same sums over all of them. */
export const figuresOf = (sources: PulseSource[]): SourceFigures => {
  const failing = sources.filter((source) => source.enabled && source.status.lastError);
  return {
    total: sources.length,
    active: sources.filter((source) => source.enabled).length,
    failingCount: failing.length,
    failing: failing.slice(0, 3).map((source) => ({ id: source.id, name: source.name, since: source.lastErrorAt })),
    waiting: sources.filter((source) => source.enabled && !source.lastError && !source.status.newestDataAt && !source.lastSeenAt).length,
    series: sources.reduce((sum, source) => sum + (source.seriesCount ?? 0), 0),
    today: sources.reduce((sum, source) => sum + (source.todayCount ?? 0), 0),
    fetchesToday: fetchesTodayOf(sources),
  };
};

/**
 * Today's fetches as the server sums them: every enabled metrics source fetches once per interval since midnight in
 * the base's zone (10:42 now, so 64 full buckets and two minutes of the next), failing ones fail every time.
 */
const fetchesTodayOf = (sources: PulseSource[]): FetchesToday => {
  const minutes = 10 * 60 + 42;
  const buckets = Array.from({ length: Math.ceil(minutes / FETCH_BUCKET_MINUTES) }, (_, index) => {
    // the last bucket counts the minute now too (a fetch at 10:42 is today's), like the minute slots of the list
    const span = Math.min(FETCH_BUCKET_MINUTES, minutes + 1 - index * FETCH_BUCKET_MINUTES);
    const bucket = { ok: 0, failed: 0 };
    for (const source of sources) {
      if (source.kind !== "metrics" || !source.enabled) continue;
      const every = source.scrapeIntervalSeconds ?? 60;
      // minutes since midnight in Berlin (23:00 UTC the evening before) when the source began to fail
      const failsFrom = source.lastErrorAt
        ? (Date.parse(source.lastErrorAt) - Date.parse("2026-11-24T23:00:00.000Z")) / 60_000
        : Number.POSITIVE_INFINITY;
      const from = index * FETCH_BUCKET_MINUTES;
      const failedMinutes = Math.max(0, Math.min(span, from + span - failsFrom));
      bucket.ok += Math.round(((span - failedMinutes) * 60) / every);
      bucket.failed += Math.round((failedMinutes * 60) / every);
    }
    return bucket;
  });
  return {
    ok: buckets.reduce((sum, bucket) => sum + bucket.ok, 0),
    failed: buckets.reduce((sum, bucket) => sum + bucket.failed, 0),
    buckets,
  };
};

export const sourcesProps = (
  options: { open?: string; sources?: PulseSource[]; alerts?: BaseAttention["alerts"]; storeDown?: boolean } = {},
): SourcesScreenProps => {
  const sources = options.sources ?? fixtureSources;
  const open = options.open ?? "";
  return {
    initialBases: fixtureBases,
    initialBaseId: fixtureBases[0]!.id,
    initialRouteState: { view: "sources", sourceId: open },
    // the server sends the first page of sources; the figures cover all of them
    initialSources: sources.slice(0, SOURCES_PAGE),
    initialSettings: { maxRawRetentionDays: 365, admins: ["Jana Petersen"] },
    initialPermissions: { write: true, admin: true },
    initialAttention: {
      readAt: FIXTURE_NOW,
      store: { unavailable: options.storeDown ?? false, since: options.storeDown ? "2026-11-25T09:20:00.000Z" : null },
      alerts: options.alerts ?? fixtureAlerts,
    },
    initialSourceScrapes: open ? { [open]: fixtureScrapesFor(open) } : {},
    initialSourceMinutes: open ? { [open]: fixtureMinutesFor(open) } : {},
    // a source that receives data has the key it receives them with
    initialSourceApiKeys: open && sources.find((source) => source.id === open)?.kind === "http_ingest" ? { [open]: fixtureApiKeys } : {},
    initialQueryCoverage: { bases: true, baseData: true, sourceDetail: true },
    initialFigures: figuresOf(sources),
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
    name: "CPU je Stunde, letzter Tag",
    sql: "-- Last of every host\nSELECT toStartOfMinute(ts) AS time, host, avg(value) AS cpu\nFROM samples\nWHERE name = :metric\nGROUP BY time, host",
    params: { metric: "node_cpu" },
    revision: 3,
    createdBy: "00000000-0000-4000-8000-0000000000a1",
    updatedBy: "00000000-0000-4000-8000-0000000000a1",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-24T16:20:00.000Z",
  },
  {
    id: "q4Ef5Gh6",
    baseId: "b7Kq2mX9",
    name: "Bestellungen pro Tag",
    sql: "SELECT toDate(ts) AS day, count() FROM events WHERE kind = 'order.created' GROUP BY day",
    params: {},
    revision: 1,
    createdBy: "00000000-0000-4000-8000-0000000000a2",
    updatedBy: "00000000-0000-4000-8000-0000000000a2",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-20T09:00:00.000Z",
  },
  {
    id: "q7Ij8Kl9",
    baseId: "b7Kq2mX9",
    name: "Freier Speicher je Laufwerk",
    sql: "SELECT host, device, min(value) AS free FROM samples WHERE name = 'node_filesystem_avail_bytes' GROUP BY host, device",
    params: {},
    revision: 4,
    createdBy: "00000000-0000-4000-8000-0000000000a3",
    updatedBy: "00000000-0000-4000-8000-0000000000a3",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-19T14:05:00.000Z",
  },
  {
    id: "q2Mn3Op4",
    baseId: "b7Kq2mX9",
    name: "Druckerfehler der Woche",
    sql: "SELECT toDate(ts) AS day, attributes['printer'] AS printer, count() FROM events WHERE kind = 'printer.error' GROUP BY day, printer",
    params: {},
    revision: 2,
    createdBy: "00000000-0000-4000-8000-0000000000a1",
    updatedBy: "00000000-0000-4000-8000-0000000000a1",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-18T08:30:00.000Z",
  },
  {
    id: "q5Qr6St7",
    baseId: "b7Kq2mX9",
    name: "Antwortzeit p95 Webshop",
    sql: "SELECT toStartOfHour(ts) AS hour, quantile(0.95)(value) AS p95 FROM samples WHERE name = 'http_request_duration_seconds' GROUP BY hour",
    params: {},
    revision: 6,
    createdBy: "00000000-0000-4000-8000-0000000000a4",
    updatedBy: "00000000-0000-4000-8000-0000000000a4",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-15T11:45:00.000Z",
  },
  {
    id: "q8Uv9Wx1",
    baseId: "b7Kq2mX9",
    name: "Netzwerk-Durchsatz je Switch",
    sql: "SELECT toStartOfMinute(ts) AS time, host, rate(value) AS bytes FROM samples WHERE name = 'node_network_receive_bytes_total' GROUP BY time, host",
    params: {},
    revision: 1,
    createdBy: "00000000-0000-4000-8000-0000000000a2",
    updatedBy: "00000000-0000-4000-8000-0000000000a2",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-12T10:10:00.000Z",
  },
  {
    id: "q3Yz4Ab5",
    baseId: "b7Kq2mX9",
    name: "Temperatur Serverraum",
    sql: "SELECT toStartOfFiveMinutes(ts) AS time, avg(value) AS celsius FROM samples WHERE name = 'room_temperature' GROUP BY time",
    params: {},
    revision: 2,
    createdBy: "00000000-0000-4000-8000-0000000000a3",
    updatedBy: "00000000-0000-4000-8000-0000000000a3",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-08T07:55:00.000Z",
  },
  {
    id: "q6Cd7Ef8",
    baseId: "b7Kq2mX9",
    name: "Anmeldungen je Stunde",
    sql: "SELECT toStartOfHour(ts) AS hour, count() FROM events WHERE kind = 'user.login' GROUP BY hour",
    params: {},
    revision: 1,
    createdBy: "00000000-0000-4000-8000-0000000000a4",
    updatedBy: "00000000-0000-4000-8000-0000000000a4",
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-02T16:40:00.000Z",
  },
];

/** The people who changed the fixture queries, by id, as the page names them. */
export const fixtureAuthors: Record<string, QueryAuthor> = Object.fromEntries(
  ["Jana Petersen", "Jonas Wolf", "Mira Aydın", "Ole Brandt"].map((name, index) => {
    const id = `00000000-0000-4000-8000-0000000000a${index + 1}`;
    return [id, { principal: { type: "user" as const, userId: id }, displayName: name }];
  }),
);

/** Worst-case sources for break-ui: long and unbreakable names and endpoints, non-Latin text, emoji, huge counts. */
export const worstSources: PulseSource[] = [
  fixtureSource({
    id: "w1Aa2Bb3",
    name: "Produktionsstraße Nord-Ost Halle 7 Schaltschrank 12 Temperatur- und Feuchtigkeitssensoren aller Etagen",
    endpointUrl: "https://sehr-lange-subdomain-ohne-umbruch.werkstatt-nord-ost.example:9100/metrics/federate/node-exporter",
    seriesCount: 9_876_543,
    status: status({
      lastError: "Metrics endpoint returned HTTP 503",
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

/** Who works in the first base: two admins, three who write, one group that reads. */
export const fixtureAccess: AccessEntry[] = [
  {
    id: "00000000-0000-4000-8000-0000000000b1",
    principal: { type: "user", userId: "00000000-0000-4000-9000-0000000000b1" },
    permission: "admin",
    createdAt: "2026-09-01T08:00:00.000Z",
    displayName: "Jana Petersen",
  },
  {
    id: "00000000-0000-4000-8000-0000000000b2",
    principal: { type: "user", userId: "00000000-0000-4000-9000-0000000000b2" },
    permission: "admin",
    createdAt: "2026-09-02T08:00:00.000Z",
    displayName: "Jonas Wolf",
  },
  {
    id: "00000000-0000-4000-8000-0000000000b3",
    principal: { type: "user", userId: "00000000-0000-4000-9000-0000000000b3" },
    permission: "write",
    createdAt: "2026-09-03T08:00:00.000Z",
    displayName: "Mira Aydın",
  },
  {
    id: "00000000-0000-4000-8000-0000000000b4",
    principal: { type: "user", userId: "00000000-0000-4000-9000-0000000000b4" },
    permission: "write",
    createdAt: "2026-09-04T08:00:00.000Z",
    displayName: "Ole Brandt",
  },
  {
    id: "00000000-0000-4000-8000-0000000000b5",
    principal: { type: "user", userId: "00000000-0000-4000-9000-0000000000b5" },
    permission: "write",
    createdAt: "2026-09-05T08:00:00.000Z",
    displayName: "Lea Sommer",
  },
  {
    id: "00000000-0000-4000-8000-0000000000b6",
    principal: { type: "group", groupId: "00000000-0000-4000-9000-0000000000b6" },
    permission: "read",
    createdAt: "2026-09-06T08:00:00.000Z",
    displayName: "Werkstatt-Team",
  },
];
