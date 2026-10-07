import type { AiConversationSource, AiFileStat } from "@k2b/cloud/ai";
import type { AssistantChatContextSnapshot, AssistantChatResult } from "../chat-context";

/** Invented demo data for the chat sidebar's tests and screenshots. */
export const SIDEBAR_NOW = "2026-10-06T12:30:00.000Z";
export const SIDEBAR_CHAT = "cHt234";

export const minutesAgo = (minutes: number, now = SIDEBAR_NOW) => new Date(Date.parse(now) - minutes * 60_000).toISOString();

export const fileResult = (
  key: string,
  input: { title?: string; description?: string; at: string; turn: string; seq: number; size?: number; mediaType?: string },
): AssistantChatResult => ({
  key,
  kind: "file",
  title: input.title ?? key.slice(key.lastIndexOf("/") + 1),
  description: input.description ?? null,
  icon: "ti ti-file",
  deliveredAt: input.at,
  turnId: input.turn,
  callId: `call-${key}`,
  messageSeq: input.seq,
  file: { path: key, mediaType: input.mediaType ?? "application/pdf", size: input.size ?? 1_400_000 },
});

export const upload = (path: string, at: string, mediaType = "text/csv", size = 210_000): AiFileStat => ({
  path,
  size,
  mediaType,
  origin: "user",
  updatedAt: at,
  version: 1,
});

export const source = (
  kind: AiConversationSource["kind"],
  key: string,
  title: string,
  at: string,
  extra: Partial<AiConversationSource> = {},
): AiConversationSource => ({
  kind,
  key,
  title,
  preview: null,
  icon: kind === "web" ? "ti ti-world" : kind === "activity" ? "ti ti-world" : "ti ti-mail",
  href: kind === "web" ? key : null,
  path: null,
  mediaType: null,
  size: null,
  ref: null,
  occurrences: 1,
  firstSeenAt: at,
  lastSeenAt: at,
  sourceTurnId: "turn",
  sourceCallId: `call-${key}`,
  sourceMessageSeq: 4,
  ...extra,
});

export const emptySidebarSnapshot = (overrides: Partial<AssistantChatContextSnapshot> = {}): AssistantChatContextSnapshot => ({
  chatId: SIDEBAR_CHAT,
  viewerUserId: "11111111-1111-4111-8111-111111111111",
  now: SIDEBAR_NOW,
  timeZone: "Europe/Berlin",
  results: [],
  resultsTruncated: false,
  files: [],
  fileCount: 0,
  working: { groups: [], groupCount: 0, looseFiles: [], count: 0, bytes: 0 },
  storage: { usedBytes: 0, maxBytes: 250 * 1024 * 1024 },
  sources: [],
  sourceCount: 0,
  sourceCursor: null,
  tasks: [],
  skills: [],
  memories: [],
  apps: [],
  runCount: 0,
  runs: [],
  ...overrides,
});

/** The chat from the design: a report, a dashboard, and a joined table, built from four uploads. */
export const sidebarSnapshot = (overrides: Partial<AssistantChatContextSnapshot> = {}): AssistantChatContextSnapshot =>
  emptySidebarSnapshot({
    results: [
      fileResult("/Umsatzbericht Q1-Q3.pdf", {
        description: "Der fertige Bericht: Umsatz je Quartal, Regionen und die 10 größten Kunden, mit Diagrammen.",
        at: minutesAgo(20),
        turn: "turn-3",
        seq: 9,
      }),
      {
        key: "assistant.artifact:App001",
        kind: "app",
        title: "Umsatz-Dashboard",
        description: "Interaktives Dashboard zum Filtern nach Quartal, Region und Kunde.",
        icon: "ti ti-chart-bar",
        deliveredAt: minutesAgo(21),
        turnId: "turn-3",
        callId: "call-app",
        messageSeq: 9,
        app: { id: "App001", href: "/app/assistant/apps/App001", published: true, lastRun: "ready" },
      },
      fileResult("/bestellungen-verknuepft.csv", {
        description: "Alle Bestellungen aus Q1–Q3 mit Kundendaten verknüpft, die Grundlage für Bericht und Dashboard.",
        at: minutesAgo(90),
        turn: "turn-2",
        seq: 5,
        mediaType: "text/csv",
        size: 620_000,
      }),
    ],
    files: [
      upload("/bestellungen-q1.csv", minutesAgo(120)),
      upload("/bestellungen-q2.csv", minutesAgo(120), "text/csv", 238_000),
      upload("/bestellungen-q3.csv", minutesAgo(120), "text/csv", 251_000),
      upload("/kunden.xlsx", minutesAgo(120), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 88_000),
    ],
    fileCount: 4,
    working: {
      groups: [
        {
          folder: "umsatzbericht-q1-q3",
          count: 7,
          bytes: 180_000,
          updatedAt: minutesAgo(22),
          mediaTypes: { "text/html": 5, "image/png": 2 },
        },
        {
          folder: "bestellungen-verknuepft",
          count: 2,
          bytes: 15_000,
          updatedAt: minutesAgo(92),
          mediaTypes: { "text/x-python": 1, "text/plain": 1 },
        },
      ],
      groupCount: 2,
      looseFiles: [],
      count: 9,
      bytes: 195_000,
    },
    sources: [
      source("activity", "web_search:umsatz q3 region süd", "Umsatz Q3 Region Süd", minutesAgo(30)),
      source("web", "https://www.destatis.de/umsatz", "Umsatzstatistik im Handel", minutesAgo(31)),
    ],
    sourceCount: 2,
    skills: [{ name: "PDF-Bericht erstellen", description: "Berichte als PDF", turns: 2, lastLoadedAt: minutesAgo(25) }],
    memories: [{ id: "mem001", content: "Umsätze immer netto in EUR angeben" }],
    ...overrides,
  });
