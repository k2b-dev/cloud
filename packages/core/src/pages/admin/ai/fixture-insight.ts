/** Invented usage and people reports for the AI area's browser fixture (Usage, Budgets › use per person). */
import type { AiUsageFeedback, AiUsageGroup, AiUsagePage, AiUsageReport, AiUsageRun, AiUsageStats } from "@k2b/cloud/ai/admin";
import {
  type AiQuotaReport,
  AiQuotaReportQuerySchema,
  type AiQuotaReportRow,
  type AiQuotaSnapshot,
  AiUsageQuerySchema,
} from "@k2b/cloud/shared";
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";
import type { AiPeopleData, AiUsageData, AiUsageViewData } from "./insight-data";

const UNTIL = Date.parse("2026-11-26T12:00:00.000Z");
const DAY = 86_400_000;
const uuid = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
/** A fixed, calm wave with quieter weekends, so every capture shows the same days. */
const wave = (index: number, base: number, swing: number) =>
  Math.round(base + swing * (0.55 + 0.35 * Math.sin(index / 3.2) + 0.1 * Math.cos(index * 1.3)) * (index % 7 >= 5 ? 0.45 : 1));

const PEOPLE = ["Ada Renz", "Mira Solberg", "Tom Oswald", "Lena Brandt", "Jonas Winter", "Sara Kraus", "Felix Nordhaus", "Eva Bergmann"];
const WORST_PEOPLE = [
  "Maximiliane Alexandra von Hohenstein-Wittgenberg zu Lindenfeld",
  "Q",
  "山田太郎",
  "🚀 Raketen-Team",
  "verwaltung.langer.funktionsaccount.ohne.leerzeichen@forschung.universitaet.example.org",
];
const MODELS: [string, string][] = [
  ["gpt-oss-120b", "cortecs/gpt-oss-120b"],
  ["mistral-small", "cortecs/mistral-small-2506"],
  ["claude", "anthropic/claude-sonnet"],
  ["gemini-flash", "google/gemini-flash"],
  ["qwen", "rechenzentrum/qwen3-32b"],
  ["whisper", "rechenzentrum/whisper-large-v3"],
];
const TASKS = ["chat-enrich", "memory-learning", "chat-title", "workflow-step", "compaction"];

const stats = (scale: number, patch: Partial<AiUsageStats> = {}): AiUsageStats => ({
  dictationMinutes: Math.round(scale * 0.4),
  runs: scale,
  failed: Math.round(scale * 0.03),
  tokens: scale * 1830,
  cost: Math.round(scale * 0.042 * 100) / 100,
  tokenCoverage: 0.97,
  costCoverage: 0.91,
  avgDurationMs: 4200,
  p95DurationMs: 12_800,
  avgOutputTokensPerSecond: 48,
  switchesAway: Math.round(scale * 0.01),
  assistantMessages: Math.round(scale * 0.7),
  positive: Math.round(scale * 0.08),
  negative: Math.round(scale * 0.02),
  rated: Math.round(scale * 0.1),
  ...patch,
});
const page = <T>(items: T[], total = items.length, perPage = 50, current = 1): AiUsagePage<T> => ({ items, total, page: current, perPage });

const run = (index: number, worst: boolean): AiUsageRun => {
  const failed = index % 6 === 2;
  const person = (worst ? WORST_PEOPLE : PEOPLE)[index % (worst ? WORST_PEOPLE.length : PEOPLE.length)]!;
  const [model, providerModel] = MODELS[index % MODELS.length]!;
  const kind = index % 5 === 0 ? "chat" : index % 7 === 0 ? "live-transcription" : "background";
  return {
    id: uuid("44444444", index),
    kind,
    task:
      worst && index % 4 === 1
        ? "workflow-step-mit-einem-sehr-langen-namen-ohne-leerzeichen-0123456789abcdef"
        : TASKS[index % TASKS.length]!,
    status: failed ? "failed" : index % 11 === 3 ? "running" : "completed",
    createdAt: new Date(UNTIL - index * 3_400_000).toISOString(),
    userId: index % 9 === 4 ? null : uuid("11111111", index % 8),
    userLabel: index % 9 === 4 ? null : person,
    modelId: model,
    providerModel,
    appId: ["core", "mail", "workflows", "assistant"][index % 4]!,
    conversationId: kind === "chat" ? uuid("33333333", index) : null,
    turnId: kind === "chat" ? uuid("55555555", index) : null,
    workflowRunId: index % 4 === 2 ? uuid("66666666", index) : null,
    workflowId: null,
    workflowName: null,
    estimated: index % 13 === 0,
    traceId: `trace-${index.toString(16).padStart(8, "0")}`,
    tokens: failed ? null : 800 + index * 37,
    cost: failed ? null : Math.round((0.003 + index * 0.0007) * 10000) / 10000,
    durationMs: 900 + index * 113,
    audioMs: null,
    errorCode: failed ? (index % 12 === 2 ? "provider_rate_limited" : "provider_error") : null,
    error: failed
      ? worst
        ? `Der Anbieter antwortete mit 502 Bad Gateway: ${"upstream connect error or disconnect/reset before headers. ".repeat(6)}`
        : "Der Anbieter antwortete mit 502 Bad Gateway."
      : null,
    attempts: failed ? 3 : 1,
    requestStartedAt: new Date(UNTIL - index * 3_400_000).toISOString(),
    generationMs: 800,
    headersMs: 120,
    firstByteMs: 240,
    firstBlockMs: 300,
    cancelled: false,
  };
};

const feedbackRow = (index: number, worst: boolean): AiUsageFeedback => {
  const person = (worst ? WORST_PEOPLE : PEOPLE)[index % (worst ? WORST_PEOPLE.length : PEOPLE.length)]!;
  const [model, providerModel] = MODELS[index % 4]!;
  const down = index % 3 !== 1;
  return {
    id: uuid("22222222", index),
    conversationId: uuid("33333333", index),
    conversationTitle:
      worst && index === 0
        ? "Ein Chat mit einem sehr langen Titel über die Planung des Jahresabschlusses und der Inventur"
        : ["Angebot für Holzwerk", "Protokoll Teamrunde", "Reisekosten November", "Übersetzung Vertrag"][index % 4]!,
    userId: uuid("11111111", index % 8),
    userLabel: person,
    modelId: model,
    providerModel,
    rating: down ? "down" : "up",
    reasons: down ? [["incorrect", "incomplete", "too_slow", "did_not_follow_request"][index % 4]!] : [],
    comment: down
      ? worst && index === 0
        ? "Die Antwort hat die Tabelle falsch zusammengefasst. ".repeat(8)
        : "Die Summe in der Tabelle stimmt nicht."
      : null,
    createdAt: new Date(UNTIL - index * 7_200_000).toISOString(),
    updatedAt: new Date(UNTIL - index * 7_000_000).toISOString(),
  };
};

const group = (id: string | null, label: string | null, scale: number, extra: Partial<AiUsageGroup> = {}): AiUsageGroup => ({
  ...stats(scale),
  id,
  label,
  ...extra,
});

/** A report of 30 days with real-looking density; `worst` breaks names, numbers and sizes on purpose. */
export const usageReport = (state: string, params: URLSearchParams): AiUsageReport => {
  const query = AiUsageQuerySchema.parse({ ...Object.fromEntries(params), until: new Date(UNTIL).toISOString() });
  const worst = state === "worst";
  const empty = state === "empty";
  const days = { "24h": 24, "7d": 7, "30d": 30, "90d": 90 }[query.range];
  const step = query.range === "24h" ? 3_600_000 : DAY;
  const people = worst ? WORST_PEOPLE : PEOPLE;
  const runs = empty ? [] : Array.from({ length: worst ? 100 : 40 }, (_, index) => run(index, worst));
  return {
    query,
    since: new Date(UNTIL - days * step).toISOString(),
    until: new Date(UNTIL).toISOString(),
    overview: empty ? stats(0) : stats(worst ? 9_876_543 : 4218),
    chat: empty ? stats(0) : stats(worst ? 5_432_109 : 2614),
    background: empty ? stats(0) : stats(worst ? 4_444_434 : 1604),
    unassignedBackgroundRuns: empty ? 0 : worst ? 123_456 : 37,
    timeline: empty
      ? []
      : Array.from({ length: days }, (_, index) => ({
          bucket: new Date(UNTIL - (days - index) * step).toISOString(),
          turns: wave(index, 90, 80),
          tokens: index === 11 ? null : wave(index, 160_000, 140_000),
          failed: wave(index + 3, 2, 6),
          cost: index === 11 ? null : wave(index, 4, 9) + (worst ? 999_999 : 0),
        })),
    users: page(
      empty ? [] : people.map((name, index) => group(uuid("11111111", index), name, wave(index, 300, 500))),
      worst ? 98_765 : people.length,
    ),
    models: page(
      empty
        ? []
        : MODELS.map(([id, providerModel], index) =>
            group(
              id,
              worst && index === 0 ? "Sehr langer Modellname mit vielen Wörtern und einer Versionsnummer 2026-11-27-preview" : id,
              wave(index, 400, 900),
              {
                providerModel,
              },
            ),
          ),
    ),
    launches: page(
      empty
        ? []
        : [
            { appId: "mail", chats: 128, users: 21 },
            { appId: "grids", chats: 64, users: 9 },
          ],
    ),
    tasks: page(empty ? [] : TASKS.map((task, index) => group(task, task, wave(index, 200, 300)))),
    apps: page(empty ? [] : ["core", "mail", "workflows", "assistant"].map((app, index) => group(app, app, wave(index, 300, 700)))),
    workflows: page(
      empty
        ? []
        : [
            group(uuid("77777777", 1), "Rechnungen prüfen", 96, { appId: "workflows" }),
            group(uuid("77777777", 2), "Bewerbungen sichten", 41, { appId: "workflows" }),
          ],
    ),
    feedback: page(empty ? [] : Array.from({ length: worst ? 50 : 12 }, (_, index) => feedbackRow(index, worst)), worst ? 54_321 : 12),
    runs: page(runs, worst ? 1_234_567 : 40, worst ? 100 : 50, query.page),
    unit: "EUR",
  };
};

/** The explorer as `loadAiUsage` hands it over: the open view's parts of the report, and no other view's. */
export const usageFixture = (input: AiFixtureInput): AiUsageData => {
  const report = usageReport(input.state, input.params);
  const compare = input.params.get("compare") === "models" ? "models" : "users";
  const view: AiUsageViewData =
    report.query.view === "overview"
      ? {
          kind: "overview",
          overview: report.overview,
          chat: report.chat,
          background: report.background,
          timeline: report.timeline,
          apps: report.apps,
          workflows: report.workflows,
          launches: report.launches,
          unassignedBackgroundRuns: report.unassignedBackgroundRuns,
        }
      : report.query.view === "comparisons"
        ? { kind: "comparisons", overview: report.overview, rows: report[compare] }
        : report.query.view === "feedback"
          ? { kind: "feedback", chat: report.chat, feedback: report.feedback }
          : { kind: "runs", runs: report.runs };
  const userId = report.query.userId;
  return {
    report: { query: report.query, since: report.since, until: report.until, unit: report.unit },
    view,
    userLabel: userId ? (report.users.items.find((row) => row.id === userId)?.label ?? null) : null,
    compare,
    open: { run: input.params.get("run"), feedback: input.params.get("feedback") },
    timeZone: "Europe/Berlin",
  };
};

const MODEL_LIST = [
  { id: "gpt-oss-120b", label: "GPT-OSS" },
  { id: "claude", label: "Claude" },
  { id: "mistral-small", label: "Mistral Small" },
  { id: "gemini-flash", label: "Gemini Flash" },
];

const account = (index: number, worst: boolean): AiQuotaReportRow => {
  const names = worst ? WORST_PEOPLE : PEOPLE;
  const used = wave(index, 4, 26);
  const limit = index % 5 === 3 ? null : 30;
  const exhausted = limit !== null && used >= limit;
  return {
    type: index % 7 === 6 ? "service_account" : "user",
    id: uuid("11111111", index),
    label: names[index % names.length]! + (index >= names.length ? ` ${index}` : ""),
    lastUsed: index % 9 === 8 ? null : new Date(UNTIL - index * 5_000_000).toISOString(),
    cost: index % 10 === 9 ? null : used + (worst ? 1_234_567.891 : 0),
    input: used * 21_000,
    output: used * 4_300,
    calls: used * 7,
    measured: used * 7 - (index % 8 === 5 ? 2 : 0),
    estimated: index % 6 === 1 ? 1 : 0,
    unknown: index % 8 === 5 ? 2 : 0,
    status: index % 8 === 5 ? "unknown" : exhausted ? "exhausted" : limit === null ? "unlimited" : "available",
    scopes: 2,
    exhausted: exhausted ? 1 : 0,
    balances: [
      { scope: "*", limit, used: Math.min(used, 999_999), unknown: index % 8 === 5 ? 2 : 0, bypassed: false },
      { scope: "claude", limit: 10, used: Math.min(used / 3, 10), unknown: 0, bypassed: false },
    ],
  };
};

export const peopleReport = (state: string, params: URLSearchParams): AiQuotaReport => {
  const query = AiQuotaReportQuerySchema.parse({ ...Object.fromEntries(params), view: "users" });
  const worst = state === "worst";
  const empty = state === "empty";
  const days = { "24h": 24, "7d": 7, "30d": 30, "90d": 90 }[query.range];
  const items = empty ? [] : Array.from({ length: worst ? 25 : 16 }, (_, index) => account(index, worst));
  const selected = query.identity ? (items.find((item) => item.id === query.identity) ?? null) : null;
  return {
    query,
    since: new Date(UNTIL - days * DAY).toISOString(),
    until: new Date(UNTIL).toISOString(),
    asOf: new Date(UNTIL).toISOString(),
    overview: empty
      ? { cost: null, accounts: 0, input: 0, output: 0, calls: 0, measured: 0, estimated: 0, unknown: 0 }
      : {
          cost: worst ? 98_765_432.1 : 184.62,
          accounts: worst ? 98_765 : 37,
          input: 4_812_000,
          output: 912_400,
          calls: worst ? 12_345_678 : 2_841,
          measured: worst ? 12_345_000 : 2_829,
          estimated: 4,
          unknown: worst ? 678 : 12,
        },
    timeline: empty
      ? []
      : Array.from({ length: days }, (_, index) => ({
          cost: index === 9 ? null : wave(index, 3, 9),
          at: new Date(UNTIL - (days - index) * DAY).toISOString(),
          input: 120_000,
          output: 30_000,
          calls: 90,
          measured: 88,
          unknown: 2,
        })),
    models: empty
      ? []
      : MODEL_LIST.map((model, index) => ({
          cost: wave(index, 20, 60),
          model: model.id,
          input: 1,
          output: 1,
          calls: 1,
          measured: 1,
          unknown: 0,
        })),
    selected: selected ? { type: selected.type, id: selected.id, label: selected.label, lastUsed: null } : null,
    items,
    total: worst ? 98_765 : items.length,
    page: query.page,
    perPage: 25,
  };
};

const snapshot = (worst: boolean): AiQuotaSnapshot => ({
  unit: "EUR",
  enabled: true,
  usage: [],
  balances: [
    {
      scope: "*",
      limit: 30,
      input: 412_000,
      output: 81_000,
      used: worst ? 29.999 : 18.4,
      unknown: worst ? 3 : 0,
      estimated: worst ? 0.4 : undefined,
      resetsAt: "2026-11-30T00:00:00.000Z",
      sources: ["Authenticated users"],
      sourceDetails: [{ principal: { type: "authenticated" }, displayName: "Authenticated users" }],
      bypassed: false,
    },
    {
      scope: "claude",
      limit: 10,
      input: 98_000,
      output: 12_000,
      used: 10,
      unknown: 0,
      resetsAt: "2026-11-30T00:00:00.000Z",
      sources: ["Gruppe Entwicklung"],
      sourceDetails: [
        {
          principal: { type: "group", groupId: "33333333-3333-4333-8333-333333333333" },
          displayName: worst ? "Arbeitsgruppe für maschinelles Lernen und angewandte Sprachverarbeitung" : "Gruppe Entwicklung",
        },
      ],
      bypassed: false,
    },
  ],
});

export const peopleFixture = (input: AiFixtureInput): AiPeopleData => {
  const report = peopleReport(input.state, input.params);
  return {
    config: { enabled: input.state !== "limitsoff", revision: 4, unit: "EUR", rules: [] },
    models: MODEL_LIST.map((model) => ({
      ...model,
      pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      enabled: true,
      capabilities: ["tools"],
    })),
    report,
    balance: report.selected ? (input.state === "balancefail" ? null : snapshot(input.state === "worst")) : null,
    timeZone: "Europe/Berlin",
  };
};

/** The reset of an allowance; a refusal answers with the service's words. */
export const insightApi: AiFixtureApi = async (request, url, state) => {
  if (url.pathname === "/api/admin/core/ai-quotas/reset" && request.method === "POST")
    return state === "resetfail"
      ? Response.json({ message: "Quota scope no longer exists." }, { status: 409 })
      : Response.json(snapshot(false));
  if (url.pathname === "/api/admin/core/ai-usage/facets")
    return Response.json({ items: PEOPLE.map((name, index) => ({ id: uuid("11111111", index), label: name })) });
  return undefined;
};
