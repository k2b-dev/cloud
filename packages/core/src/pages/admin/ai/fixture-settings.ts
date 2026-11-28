/** Invented AI registry settings for the AI area's browser fixture (General, Background jobs, Tools & API). */
import { recentChanges } from "../_area/RecentChanges";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";
import { type AiSettingsData, aiSectionEntries, aiSettingsSections } from "./settings-data";

const ADA = { id: "22222222-2222-4222-8222-222222222222", name: "Ada Renz" };
const LONG_NAME = { id: "33333333-3333-4333-8333-333333333333", name: "Maximiliane Theodora von Hohenberg-Wartenstein" };

/**
 * One AI setting as the registry sends it: the English words of the registry (the screen gives its own), German
 * words where the registry has them. `stored` is a value of its own, with who saved it and when.
 */
const entry = (
  key: string,
  kind: SettingFieldDef["kind"],
  value: unknown,
  label: string,
  extra: Partial<SettingFieldDef> & { stored?: boolean } = {},
): SettingFieldDef => {
  const { stored, ...rest } = extra;
  return {
    key,
    label,
    description: "",
    kind,
    value,
    default: value,
    resetValue: value,
    valueSource: stored ? "custom" : "default",
    resetValueSource: "default",
    isCustom: stored === true,
    unreadable: false,
    group: "ai",
    updatedAt: stored ? "2026-11-20T08:00:00.000Z" : null,
    updatedBy: null,
    ...rest,
  };
};

const rawEntries = (state: string, locale: "de" | "en"): SettingFieldDef[] => {
  const de = locale === "de";
  const worst = state === "worst";
  const fresh = state === "empty";
  return [
    entry("ai.enabled", "boolean", !fresh, "Enable AI", {
      stored: !fresh,
      updatedAt: "2026-11-26T15:20:00.000Z",
      updatedBy: fresh ? null : ADA,
    }),
    entry(
      "ai.global_instructions",
      "template",
      fresh
        ? ""
        : worst
          ? `Antworte immer auf Deutsch. ${"Sehr lange Organisationsrichtlinie ohne Pause ".repeat(12)}https://intranet.example.org/richtlinien/ki/${"a".repeat(80)}`
          : "Antworte knapp und auf Deutsch. Der heutige Tag ist {{ today }}.",
      "Global Instructions",
      {
        stored: !fresh,
        updatedAt: "2026-11-24T09:12:00.000Z",
        updatedBy: worst ? LONG_NAME : fresh ? null : ADA,
        templateVars: ["user.displayName", "user.uid", "user.mail", "appId", "now", "today", "time"],
        placeholder: "Keep answers concise. The current user is {{ user.displayName }} and today is {{ today }}.",
      },
    ),
    entry("ai.local_client_instructions", "text", "", "Instructions for local clients"),
    entry("ai.turn_timeout_minutes", "number", worst ? 99_999 : 30, "Run time limit (minutes)", { min: 0, stored: worst }),
    entry("ai.max_tool_result_chars", "number", 2_000_000, "Tool Result Ceiling", { min: 500, max: 4_000_000 }),
    entry("ai.live_dictation_concurrency", "number", 4, de ? "Gleichzeitige Live-Diktate" : "Concurrent live dictations", {
      min: 1,
      max: 1024,
      description: de ? "Modellkapazität der Installation." : "Installation-wide live model capacity.",
    }),
    entry(
      "ai.live_dictation_minutes_per_day",
      "number",
      60,
      de ? "Live-Diktat-Minuten pro Person und Tag" : "Live dictation minutes per person per day",
      {
        min: 1,
        max: 1440,
      },
    ),
    entry(
      "ai.workflow_budget",
      "text",
      '{"globalConcurrent":8,"perSourceConcurrent":2,"ratePerMinute":120}',
      de ? "KI-Workflow-Budget" : "Workflow AI budget",
      {
        description: de
          ? "JSON-Grenzen für Quellen, Rate und gleichzeitige Arbeit."
          : "JSON limits for source, rate and concurrency admission.",
      },
    ),
    entry(
      "ai.workflow_attempt_timeout_ms",
      "number",
      60_000,
      de ? "Zeitlimit je KI-Workflow-Versuch (ms)" : "Workflow AI attempt timeout (ms)",
      {
        min: 1,
      },
    ),
    entry(
      "ai.workflow_queue_timeout_ms",
      "number",
      60_000,
      de ? "Wartezeitlimit für KI-Workflows (ms)" : "Workflow AI queue timeout (ms)",
      {
        min: 1,
      },
    ),
    entry("ai.enrich_cron", "cron", "*/10 * * * *", "Chat Enrichment Schedule"),
    entry(
      "ai.chat_enrichment_instructions",
      "text",
      fresh ? "" : "Nutze die Teamnamen aus unserem Organigramm, wenn sie im Chat vorkommen.",
      "Additional Chat Enrichment Instructions",
      { stored: !fresh, updatedAt: "2026-11-25T11:40:00.000Z", updatedBy: fresh ? null : ADA },
    ),
    entry("ai.memory_learning_cron", "cron", "*/10 * * * *", "Personalization Learning Schedule"),
    entry("ai.memory_learning_monthly_token_budget", "number", worst ? 10_000_000 : 100_000, "Personalization Monthly Token Budget", {
      min: 10_000,
      max: 10_000_000,
      stored: worst,
    }),
    entry("ai.memory_learning_instructions", "text", "", "Additional Personalization Instructions"),
    entry("ai.compaction_instructions", "text", "", "Additional Compaction Instructions"),
    entry("ai.firecrawl_api_key", "secret", "", "Firecrawl API Key", { stored: !fresh, placeholder: "fc-..." }),
    entry("ai.openai_api_enabled", "boolean", !fresh, de ? "OpenAI-kompatible API" : "OpenAI-compatible API", { stored: !fresh }),
    entry(
      "ai.openai_api_max_concurrent_requests",
      "number",
      4,
      de ? "Gleichzeitige Anfragen pro Konto (OpenAI-API)" : "OpenAI API concurrent requests per account",
      { min: 1, max: 64 },
    ),
  ];
};

const TASK_PROMPTS = {
  "ai.chat_enrichment_instructions": [
    'You summarize one chat for search.\n\nReturn JSON: { "title": string, "summary": string, "keywords": string[] }.\n\n- Keep the title under 60 characters.\n- Use the chat\'s language.',
  ],
  "ai.memory_learning_instructions": [
    "Original turn learning prompt: find durable preferences in the finished turn.",
    "Original workflow prompt: find workflows the person repeats.",
  ],
  "ai.compaction_instructions": ["Hand the chat over completely: goals, decisions, open questions, every identifier."],
};

const run = (index: number, status: "ok" | "failed" | "skipped", title: string) => ({
  id: `run-${index}`,
  conversationId: `c0ffee00-0000-4000-8000-${String(index).padStart(12, "0")}`,
  status,
  trigger: index % 3 === 0 ? ("manual" as const) : ("scheduled" as const),
  modelId: "gpt-oss-120b",
  mode: "native",
  durationMs: status === "skipped" ? null : 800 + index * 137,
  titleUpdated: status === "ok",
  keywordsCount: status === "ok" ? 6 : 0,
  error: status === "failed" ? "Provider answered 502" : null,
  createdAt: "2026-11-26T14:00:00.000Z",
  conversationTitle: title,
  when: `26.11.2026, ${String(14 - (index % 10)).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}`,
});

const enrichment = (state: string): NonNullable<AiSettingsData["enrichment"]> => {
  const worst = state === "worst";
  const fresh = state === "empty";
  const titles = [
    "Angebot Holzwerk Brandt",
    "Reisekosten November",
    "Fragen zur Datenschutzerklärung",
    "Kundenbrief entwerfen",
    "Q4-Bericht",
  ];
  const recentRuns = fresh
    ? []
    : worst
      ? [
          run(0, "failed", `Besprechung ${"sehr lange Tagesordnung ".repeat(10)}`),
          run(1, "ok", "東京オフィスとの打ち合わせメモ"),
          run(2, "skipped", ""),
          run(3, "ok", "🚀"),
          ...Array.from({ length: 6 }, (_, index) => run(index + 4, "ok", `Chat ${index + 4}`)),
        ]
      : titles.map((title, index) => run(index, index === 2 ? "failed" : "ok", title));
  return {
    totalConversations: worst ? 9_876_543 : fresh ? 0 : 412,
    dirtyConversations: worst ? 1_234_567 : fresh ? 0 : 12,
    failedConversations: worst ? 98_765 : fresh ? 0 : 2,
    oldestDirtyAt: fresh ? null : "2026-11-26T09:12:00.000Z",
    oldestDirty: fresh ? null : "26.11.2026, 10:12",
    lastRunAt: fresh ? null : "2026-11-26T14:00:00.000Z",
    lastRun: fresh ? null : "26.11.2026, 15:00",
    avgDurationMs: fresh ? null : worst ? 3_599_999 : 1_840,
    failedRuns24h: worst ? 4_321 : fresh ? 0 : 3,
    totalRuns24h: worst ? 9_999 : fresh ? 0 : 71,
    errorRate24h: worst ? 43.2 : fresh ? 0 : 4.2,
    recentRuns,
  };
};

export const settingsFixture = (input: AiFixtureInput): AiSettingsData => {
  const section = (["general", "jobs", "tools"] as const).find((name) => name === input.params.get("sec")) ?? "general";
  const entries = aiSectionEntries(rawEntries(input.state, input.locale), section, input.locale);
  const word = (iso: string) =>
    new Intl.DateTimeFormat(input.locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso));
  return {
    section,
    entries,
    sections: aiSettingsSections(
      section,
      entries.map((entry) => entry.key),
      input.locale,
    ),
    recent: recentChanges(entries, input.locale, word),
    enrichment: section === "jobs" ? enrichment(input.state) : null,
    prompts: section === "jobs" ? TASK_PROMPTS : undefined,
    showJobsLink: true,
  };
};

/** The settings API: a save is taken; `savefail` refuses every changed field with a reason, `runfail` the enrichment run. */
export const settingsApi: AiFixtureApi = async (request, url, state) => {
  if (url.pathname === "/api/admin/core/settings/run-ai-enrichment" && request.method === "POST")
    return state === "runfail"
      ? Response.json({ ok: false, message: "The provider did not answer." }, { status: 502 })
      : Response.json({ ok: true, summary: { scanned: 25, enriched: 12, failed: 0 } });
  if (url.pathname === "/api/admin/core/settings/entries" && request.method === "GET")
    return Response.json({ items: rawEntries(state, "en") });
  if (url.pathname === "/api/admin/core/settings" && request.method === "PUT") {
    if (state === "savefail") {
      const body = (await request.clone().json()) as { updates?: Record<string, unknown> };
      const message = "Instructions could not be saved. Try again.";
      return Response.json(
        { message, errors: Object.fromEntries(Object.keys(body.updates ?? {}).map((key) => [key, message])) },
        { status: 400 },
      );
    }
    return Response.json({ ok: true });
  }
  return undefined;
};
