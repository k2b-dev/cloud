import type { SyncScheduleRow } from "../../sync/service";
import { kindsOf, parseRunsAddress, RUNS_PER_PAGE, RUNS_PREVIEW, type RunKind, runsQuery } from "../query";
import type { RunRecord, RunRow, RunsPart } from "../service";

// Invented runs for render and browser tests: fixed times, no production data.

export const FIXTURE_APPS = [
  { id: "mail", label: "Mail", icon: "mail" },
  { id: "files", label: "Dateien", icon: "folder" },
  { id: "notebooks", label: "Notizbücher", icon: "notebook" },
  { id: "werkstatt", label: "Kunden & Aufträge (Werkstatt Nord)", icon: "tool" },
];

const at = (minutes: number) => new Date(Date.parse("2026-11-24T09:44:00.000Z") - minutes * 60_000).toISOString();

const JOBS: RunRow[] = Array.from({ length: 48 }, (_, index) => ({
  ref: { kind: "job", id: `${index.toString(16).padStart(32, "0")}:${index.toString(16).padStart(16, "0")}` },
  appId: FIXTURE_APPS[index % 3]!.id,
  name: ["Postfach abgleichen", "Vorschaubilder erzeugen", "Suchindex nachziehen", "Nachtabgleich Kalender"][index % 4]!,
  detail: ["mail:imap-sync", "files:thumbnails", "notebooks:reindex", "mail:calendar"][index % 4]!,
  status: index === 0 ? "running" : index % 7 === 3 ? "failed" : "succeeded",
  state: index === 0 ? "running" : index % 7 === 3 ? "error" : "ok",
  at: at(index * 3),
  durationMs: index === 0 ? null : [412, 1_830, 64, 12_400][index % 4]!,
}));

const WORKFLOWS: RunRow[] = Array.from({ length: 12 }, (_, index) => ({
  ref: { kind: "workflow", id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` },
  appId: "mail",
  name: index % 2 ? "Rechnung ablegen" : "Neue Anfrage zuordnen",
  detail: index === 2 ? "Postfach nicht erreichbar" : "mail.received",
  status: index === 2 ? "failed" : index === 0 ? "waiting" : "succeeded",
  state: index === 2 ? "failed" : index === 0 ? "waiting" : "succeeded",
  at: at(index * 11 + 2),
  durationMs: index === 0 ? null : 2_300 + index * 40,
  recordHref: `/admin/observability/workflows?run=00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
}));

const DELIVERIES: RunRow[] = Array.from({ length: 30 }, (_, index) => ({
  ref: { kind: "delivery", id: `6f1c0d2e-0000-4000-8000-${String(index).padStart(12, "0")}` },
  appId: index % 2 ? "files" : "mail",
  name: index % 2 ? "Datei geteilt: Angebot 2026.pdf" : "Neue Nachricht von Haus Bergmann",
  detail: index % 3 ? "Mia Muster · E-Mail" : "Jonas Weber · Push",
  status: index === 4 ? "failed" : index === 1 ? "waiting" : "succeeded",
  state: index === 4 ? "failed" : index === 1 ? "deferred" : "delivered",
  at: at(index * 5 + 1),
  durationMs: index === 1 ? null : 900 + index * 30,
}));

const DEAD_LETTERS: RunRow[] = [
  {
    ref: { kind: "deadLetter", id: "mail/queue/send/m-1" },
    appId: "mail",
    name: "send",
    detail: "SMTP 550 — Postfach unbekannt",
    status: "failed",
    state: "queue",
    at: at(40),
    durationMs: null,
    recordHref: "/admin/observability/nats/sync?storeApp=mail&kind=queue&store=send&message=m-1",
  },
];

/**
 * The worst real data each column meets (break-ui): long names and source keys, a removed app, no app, an app with a
 * long name, Cyrillic, Arabic and emoji, zero and day-long durations, a long dead-letter reason and five-digit counts.
 */
const WORST: Record<RunKind, RunRow[]> = {
  job: [
    {
      ref: { kind: "job", id: `${"a".repeat(32)}:${"b".repeat(16)}` },
      appId: "legacy-crm",
      name: "Vorschaubilder für alle Dateien im Ordner „Angebote 2026 / Kunden mit Rahmenvertrag / Nachträge“ neu erzeugen",
      detail: "files:thumbnails:workspace-7f3a9c2e-1b4d-4e8a-9c0d-2b6f1e3a5d7c:regenerate-all",
      status: "running",
      state: "running",
      at: at(0),
      durationMs: 86_400_000 + 3 * 3_600_000,
    },
    {
      ref: { kind: "job", id: `${"c".repeat(32)}:${"d".repeat(16)}` },
      appId: null,
      name: "Ping",
      detail: "",
      status: "succeeded",
      state: "ok",
      at: at(1),
      durationMs: 0,
    },
    {
      ref: { kind: "job", id: `${"e".repeat(32)}:${"f".repeat(16)}` },
      appId: "werkstatt",
      name: "Отчёт за месяц 📊 — ежемесячная выгрузка",
      detail: "reports:monthly",
      status: "failed",
      state: "error",
      at: at(2),
      durationMs: 59_960,
    },
  ],
  workflow: [
    {
      ref: { kind: "workflow", id: "11111111-0000-4000-8000-000000000001" },
      appId: "mail",
      name: "تحديث بيانات العملاء",
      detail: "",
      status: "waiting",
      state: "needs_attention",
      at: at(3),
      durationMs: null,
      recordHref: "/admin/observability/workflows?run=11111111-0000-4000-8000-000000000001",
    },
  ],
  delivery: [
    {
      ref: { kind: "delivery", id: "22222222-0000-4000-8000-000000000001" },
      appId: "mail",
      name: "Neue Nachricht von bartholomew.fitzgerald@northwind-industries-holdings.example.com",
      detail: "Aleksandra Wiśniewska-Kowalczyk · E-Mail",
      status: "canceled",
      state: "suppressed",
      at: at(4),
      durationMs: null,
    },
  ],
  deadLetter: [
    {
      ref: { kind: "deadLetter", id: "mail/queue/send/m-9" },
      appId: "mail",
      name: "outgoing-mail-delivery-with-retry-and-dkim-signing",
      detail:
        "SMTP 451 4.7.1 — Try again later: greylisted by smtp.stadtwerke-nordhausen-energieversorgung.example (temporary failure, see RFC 6647)",
      status: "failed",
      state: "queue",
      at: at(5),
      durationMs: null,
      recordHref: "/admin/observability/nats/sync?storeApp=mail&kind=queue&store=send&message=m-9",
    },
  ],
};
/** Counts the stores report for the worst case: five digits with separators. */
const WORST_TOTALS: Record<RunKind, number | null> = { job: 12_345, workflow: null, delivery: 1, deadLetter: 1 };

/** 1,000 job runs: one kind pages through them 100 at a time, so the page never holds more than 100 rows. */
const HUGE: RunRow[] = Array.from({ length: 1000 }, (_, index) => ({
  ref: { kind: "job", id: `${index.toString(16).padStart(32, "0")}:${index.toString(16).padStart(16, "1")}` },
  appId: FIXTURE_APPS[index % 3]!.id,
  name: `Postfach abgleichen #${1000 - index}`,
  detail: "mail:imap-sync",
  status: index % 13 === 5 ? "failed" : "succeeded",
  state: index % 13 === 5 ? "error" : "ok",
  at: at(index),
  durationMs: 400 + (index % 9) * 130,
}));

export type FixtureData = "normal" | "worst" | "huge";

const ALL: Record<RunKind, RunRow[]> = { job: JOBS, workflow: WORKFLOWS, delivery: DELIVERIES, deadLetter: DEAD_LETTERS };
const COUNTED: Record<RunKind, boolean> = { job: true, workflow: false, delivery: true, deadLetter: true };

/** The parts of the list for an address, as the service would answer from these runs. */
export const fixtureParts = (search: string, page = 1, data: FixtureData = "normal"): RunsPart[] => {
  const query = runsQuery("de", FIXTURE_APPS);
  const { state } = parseRunsAddress(query, new URLSearchParams(search));
  const kinds = kindsOf(state);
  const limit = kinds.length === 1 ? RUNS_PER_PAGE : RUNS_PREVIEW;
  const offset = kinds.length === 1 ? (page - 1) * RUNS_PER_PAGE : 0;
  return kinds.map((kind) => {
    const source = data === "worst" ? WORST[kind] : data === "huge" ? (kind === "job" ? HUGE : []) : ALL[kind];
    const all = source.filter(
      (row) =>
        (!state.filters.status || row.status === state.filters.status) &&
        (!state.filters.app || row.appId === state.filters.app) &&
        (!state.search || `${row.name} ${row.detail}`.toLowerCase().includes(state.search.toLowerCase())),
    );
    return {
      kind,
      rows: all.slice(offset, offset + limit),
      total: data === "worst" ? WORST_TOTALS[kind] : COUNTED[kind] ? all.length : null,
      more: data === "worst" ? WORST_TOTALS[kind] === null || (WORST_TOTALS[kind] ?? 0) > all.length : offset + limit < all.length,
      error: null,
    };
  });
};

export const fixtureJobRecord: RunRecord = {
  kind: "job",
  span: {
    traceId: "0".repeat(32),
    spanId: "3".repeat(16),
    traceparent: null,
    spanKey: null,
    parentSpanId: null,
    name: "Suchindex nachziehen",
    source: "notebooks:reindex",
    appId: "notebooks",
    category: "job",
    kind: "internal",
    status: "error",
    statusMessage: "Zeitüberschreitung nach 30 s beim Lesen von Notizbuch „Handbuch“",
    attributes: null,
    summary: null,
    eventCount: 2,
    startedAt: at(9),
    endedAt: at(8.5),
    durationMs: 30_012,
    updatedAt: at(8.5),
  } as never,
  events: [
    {
      id: "e1",
      traceId: "0".repeat(32),
      spanId: "3".repeat(16),
      name: "index.start",
      severity: "info",
      attributes: null,
      body: null,
      occurredAt: at(9),
    },
    {
      id: "e2",
      traceId: "0".repeat(32),
      spanId: "3".repeat(16),
      name: "index.timeout",
      severity: "error",
      attributes: null,
      body: "30 s",
      occurredAt: at(8.5),
    },
  ] as never,
};

export const fixtureSchedules: SyncScheduleRow[] = [
  {
    appId: "mail",
    appName: "Mail",
    schedulerId: "mail-maintenance",
    id: "nightly-calendar-sync",
    cron: "0 3 * * *",
    timezone: "Europe/Berlin",
    misfire: "skip",
    nextRunAt: "2026-11-25T02:00:00.000Z",
    runNumber: 41,
    failureCount: 0,
    lastError: null,
    lastRunId: null,
    lastCompletedAt: "2026-11-24T02:00:12.000Z",
    handlerAvailable: true,
    createdAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-11-24T02:00:12.000Z",
    meta: null,
  } as never,
];
