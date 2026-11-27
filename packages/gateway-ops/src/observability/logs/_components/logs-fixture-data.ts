import type { AdminAreaGroup } from "@k2b/cloud/ssr";
import type { LogEntry, LogLevel } from "../contracts";
import { LOG_LEVELS, LOGS_PER_PAGE, type LogSearch } from "../query";
import type { LogsData } from "./LogsScreen";

// Invented log entries for render, browser tests and screenshots: fixed times, no production data.

/** The moment the fixture is looked at; the entries are the minutes before it. */
export const FIXTURE_NOW = new Date("2026-11-24T09:44:10.000Z");
export const FIXTURE_TIME_ZONE = "Europe/Berlin";
export const FIXTURE_TODAY = "2026-11-24";

const ENTRIES: [string, LogLevel, string, string, Record<string, unknown> | null][] = [
  [
    "09:43:48.377",
    "error",
    "gateway",
    "Upstream mail: Zeitüberschreitung nach 30 s",
    { requestId: "7f3a9c", durationMs: 30012, upstream: "mail" },
  ],
  [
    "09:43:35.992",
    "error",
    "mail",
    "SMTP-Verbindung: Zeitüberschreitung (timeout) nach 30 s",
    { requestId: "7f3a9c", durationMs: 30004, host: "smtp.example.org" },
  ],
  [
    "09:43:22.648",
    "error",
    "mail",
    "Zustellung fehlgeschlagen: 550 Postfach unbekannt",
    { requestId: "704879", durationMs: 64, rcpt: "info@stadtwerke.example" },
  ],
  ["09:42:44.820", "error", "gateway", "502 von gustav bei POST /gustav/api/turn", { requestId: "2b2dd8", durationMs: 1392 }],
  ["09:42:28.153", "warn", "mail", "Zustellung verzögert: Greylisting bei stadtwerke.example", { requestId: "cc5031", durationMs: 145 }],
  ["09:42:06.622", "warn", "mail", "IMAP-Abgleich dauert länger als 20 s", { requestId: "31415c", durationMs: 1015, mailbox: "mbx_info" }],
  ["09:41:59.040", "info", "core", "Anmeldung mit Passkey · Mia Muster", { requestId: "a1b2c3", durationMs: 88 }],
  ["09:41:46.394", "warn", "mail", "Zustellung verzögert: Greylisting bei stadtwerke.example", { requestId: "32f4dc", durationMs: 519 }],
  ["09:41:12.500", "info", "notebooks", "Export „Handbuch“ fertig (18 Seiten)", { requestId: "e4f5a6", durationMs: 2210, pages: 18 }],
  ["09:40:41.431", "error", "mail", "SMTP-Verbindung: Zeitüberschreitung (timeout) nach 30 s", { requestId: "88ca68", durationMs: 416 }],
  ["09:40:24.944", "warn", "mail", "Zustellung verzögert: Greylisting bei stadtwerke.example", { requestId: "aa46f6", durationMs: 1052 }],
  ["09:40:02.118", "debug", "assistant", "Hintergrundaufgabe „Wochenrückblick“ geplant", null],
  ["09:39:31.596", "warn", "gateway", "Langsame Antwort von mail: 1.840 ms", { requestId: "818b95", durationMs: 120 }],
  ["09:33:17.032", "error", "mail", "SMTP-Verbindung: Zeitüberschreitung (timeout) nach 30 s", { requestId: "3109c8", durationMs: 86 }],
  ["09:32:50.770", "info", "files", "Freigabe-Link erstellt · Ordner „Angebote 2026“", { requestId: "5d6e7f", durationMs: 41 }],
];

/** 110 quiet sync rounds earlier in the morning, one every 40 s from 08:00 UTC: with them the last 24 hours fill two pages. */
const ROUNDS: LogEntry[] = Array.from({ length: 110 }, (_, index) => ({
  id: String(8000 + index),
  level: "debug",
  source: "sync",
  message: `Abgleich Runde ${110 - index} fertig`,
  metadata: { round: 110 - index },
  createdAt: new Date(Date.parse("2026-11-24T08:00:00.000Z") + (109 - index) * 40_000).toISOString(),
}));

export const fixtureEntries: LogEntry[] = [
  ...ENTRIES.map(([time, level, source, message, metadata], index) => ({
    id: String(9000 + index),
    level,
    source,
    message,
    metadata,
    createdAt: `2026-11-24T${time}Z`,
  })),
  ...ROUNDS,
];

/** The service's filter over the invented entries: the same window, levels, sources and text matches. */
export const fixtureSearch = (filter: LogSearch, page = 1, entries: readonly LogEntry[] = fixtureEntries): LogsData => {
  const text = filter.search?.toLowerCase();
  const request = filter.request?.toLowerCase();
  const matching = entries.filter((entry) => {
    const at = Date.parse(entry.createdAt);
    const metadata = JSON.stringify(entry.metadata ?? {}).toLowerCase();
    return (
      at >= filter.since.getTime() &&
      (!filter.until || at < filter.until.getTime()) &&
      (!filter.levels?.length || filter.levels.includes(entry.level)) &&
      (!filter.sources?.length || filter.sources.includes(entry.source)) &&
      (!text || entry.message.toLowerCase().includes(text) || metadata.includes(text)) &&
      (!request || (entry.metadata !== null && metadata.includes(request)))
    );
  });
  const levels = Object.fromEntries(LOG_LEVELS.map((level) => [level, matching.filter((entry) => entry.level === level).length])) as Record<
    LogLevel,
    number
  >;
  return { entries: matching.slice((page - 1) * LOGS_PER_PAGE, page * LOGS_PER_PAGE), total: matching.length, levels };
};

export const fixtureArea: { title: string; groups: AdminAreaGroup[]; markLabel: string } = {
  title: "Betrieb",
  markLabel: "Braucht Aufmerksamkeit",
  groups: [
    { items: [{ id: "home", label: "Übersicht", href: "/admin/observability", icon: "ti ti-dashboard", mark: "warning" }] },
    {
      title: "Ansehen",
      items: [
        { id: "logs", label: "Protokolle", href: "/admin/observability/logs", icon: "ti ti-file-text" },
        { id: "jobs", label: "Jobs", href: "/admin/observability/jobs", icon: "ti ti-hourglass" },
        { id: "telemetry", label: "Anfragen", href: "/admin/observability/telemetry", icon: "ti ti-activity" },
      ],
    },
    {
      title: "Dienste",
      items: [
        { id: "gateway", label: "Gateway & Routen", href: "/admin/observability/gateway/routes", icon: "ti ti-route" },
        { id: "nats", label: "NATS & Sync", href: "/admin/observability/nats", icon: "ti ti-topology-star-3", mark: "warning" },
      ],
    },
    {
      title: "Einrichtung",
      items: [{ id: "retention", label: "Aufbewahrung", href: "/admin/observability/retention", icon: "ti ti-archive" }],
    },
  ],
};

/**
 * The realistic worst case of the log list (break-ui): a message, a source and metadata have no length limit in
 * `logging.entries`, so these carry a stack trace with line breaks, an unbreakable address, long source names, a UUID
 * request ID, durations from 0 ms to over an hour, an empty message, markup, emoji and Arabic, an entry of yesterday,
 * and 1,284 entries in the window (13 pages).
 */
const WORST: [string, LogLevel, string, string, Record<string, unknown> | null][] = [
  [
    "09:44:09.999",
    "error",
    "mail-outbound-delivery-worker-eu-central-1",
    "TypeError: Cannot read properties of undefined (reading 'mailbox')\n    at syncMailbox (/app/packages/mail/src/sync/imap.ts:412:18)\n    at async Promise.all (index 3)\n    at async runRound (/app/packages/mail/src/sync/round.ts:88:5)",
    { requestId: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f", durationMs: 4_611_686 },
  ],
  [
    "09:44:01.000",
    "warn",
    "gateway",
    "GET https://cloud.example.test/app/files/api/v1/shares/9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f/download?filename=Q3_Board_Deck_FINAL_revised_v12_approved_by_legal.pdf&token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 antwortete 499",
    { request_id: "req_01HZX9Q8W3V6Y7T2K4M5N8P0RS", duration_ms: 0 },
  ],
  ["09:43:59.500", "info", "core", "", { requestId: "a", durationMs: -1 }],
  ["09:43:58.000", "debug", "notebooks.export.pdf-renderer.chromium-headless", "<script>alert(1)</script> &amp; **fett**", null],
  ["09:43:57.000", "info", "assistant", "🦊 👩🏽‍💻 Wochenrückblick für Aleksandra Wiśniewska-Kowalczyk fertig", { durationMs: 0.1 + 0.2 }],
  ["09:43:56.000", "warn", "spaces", "تمت مزامنة التقويم مع خادم المستخدم نور الهدى عبد الرحمن", { requestId: 42 }],
  ["09:43:55.000", "error", "j", "Benachrichtigungseinstellungen", { durationMs: "schnell" }],
];

export const worstEntries: LogEntry[] = [
  ...WORST.map(([time, level, source, message, metadata], index) => ({
    id: String(90_000 + index),
    level,
    source,
    message,
    metadata,
    createdAt: `2026-11-24T${time}Z`,
  })),
  // yesterday in Berlin, still inside the 24 hours: the time column carries the day
  { id: "89999", level: "info", source: "core", message: "Anmeldung · J", metadata: null, createdAt: "2026-11-23T22:59:59.999Z" },
  ...Array.from({ length: 1284 - WORST.length - 1 }, (_, index) => ({
    id: String(10_000 + index),
    level: LOG_LEVELS[index % 4]!,
    source: index % 2 ? "sync" : "mail-outbound-delivery-worker-eu-central-1",
    message: `Abgleich Runde ${index + 1} fertig`,
    metadata: { round: index + 1, durationMs: index * 37 },
    createdAt: new Date(Date.parse("2026-11-24T09:43:00.000Z") - index * 45_000).toISOString(),
  })),
];
