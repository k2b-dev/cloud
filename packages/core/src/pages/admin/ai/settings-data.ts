import { aiConversations } from "@k2b/cloud/ai";
import { AI_BACKGROUND_TASK_PROMPTS } from "@k2b/cloud/ai/admin";
import { AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS, formatDateTime } from "@k2b/cloud/shared";
import { recentChanges } from "../_area/RecentChanges";
import type { RegistryFormSection } from "../_area/RegistryForm";
import { aiSettingsMessages } from "../settings/_components/ai-settings-messages";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { buildEntries } from "../settings/entries";
import type { AiPageInput } from "./page-input";

export type AiSettingsSection = "general" | "jobs" | "tools";

/** The registry keys each section shows, in the order of its groups; any other AI key stands under General. */
export const AI_SETTINGS_KEYS: Record<AiSettingsSection, readonly string[]> = {
  general: [
    "ai.enabled",
    "ai.global_instructions",
    "ai.local_client_instructions",
    "ai.turn_timeout_minutes",
    "ai.max_tool_result_chars",
    "ai.live_dictation_concurrency",
    "ai.live_dictation_minutes_per_day",
    "ai.workflow_budget",
    "ai.workflow_attempt_timeout_ms",
    "ai.workflow_queue_timeout_ms",
  ],
  jobs: [
    "ai.enrich_cron",
    "ai.chat_enrichment_instructions",
    "ai.memory_learning_cron",
    "ai.memory_learning_monthly_token_budget",
    "ai.memory_learning_instructions",
    "ai.compaction_instructions",
  ],
  tools: ["ai.firecrawl_api_key", "ai.openai_api_enabled", "ai.openai_api_max_concurrent_requests"],
};

/**
 * The words the AI area gives the registry fields the registry words in English only (the registry and the shared
 * German copy do not translate them; k2b gap, see the report), in the page's language.
 */
const aiFieldCopy = (locale: string): Record<string, Partial<Pick<SettingFieldDef, "label" | "description" | "placeholder">>> => {
  const t = aiSettingsMessages.resolve([locale]).t;
  return {
    "ai.enabled": { label: t.settingAiEnabled, description: t.aiAvailability },
    "ai.global_instructions": { label: t.globalInstructions, description: t.globalInstructionsDescription },
    "ai.local_client_instructions": {
      label: t.localClientInstructions,
      description: t.localClientInstructionsDescription,
      placeholder: AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS,
    },
    "ai.turn_timeout_minutes": { label: t.turnTimeout, description: t.turnTimeoutDescription },
    "ai.max_tool_result_chars": { label: t.toolResultCeiling, description: t.toolResultCeilingDescription },
    "ai.enrich_cron": { label: t.chatEnrichmentSchedule, description: t.chatEnrichmentScheduleDescription },
    "ai.chat_enrichment_instructions": {
      label: t.chatEnrichmentInstructions,
      description: t.chatEnrichmentInstructionsDescription,
      placeholder: t.chatEnrichmentPlaceholder,
    },
    "ai.memory_learning_cron": { label: t.personalizationSchedule, description: t.personalizationScheduleDescription },
    "ai.memory_learning_monthly_token_budget": { label: t.monthlyBudget, description: t.monthlyBudgetDescription },
    "ai.memory_learning_instructions": {
      label: t.personalizationInstructions,
      description: t.personalizationInstructionsDescription,
      placeholder: t.personalizationPlaceholder,
    },
    "ai.compaction_instructions": {
      label: t.compactionInstructions,
      description: t.compactionInstructionsDescription,
      placeholder: t.compactionPlaceholder,
    },
    "ai.firecrawl_api_key": { label: t.firecrawlKey, description: t.firecrawlDescription },
  };
};

/** The section's fields with the AI area's words; General also takes every AI key no section names. */
export const aiSectionEntries = (entries: readonly SettingFieldDef[], section: AiSettingsSection, locale: string): SettingFieldDef[] => {
  const copy = aiFieldCopy(locale);
  const named = new Set(Object.values(AI_SETTINGS_KEYS).flat());
  return entries
    .filter((entry) => AI_SETTINGS_KEYS[section].includes(entry.key) || (section === "general" && !named.has(entry.key)))
    .map((entry) => ({ ...entry, ...copy[entry.key] }));
};

/** The registry groups of a section, by hand, with their titles; a group without one field of this Cloud stays away. */
export const aiSettingsSections = (section: AiSettingsSection, keys: readonly string[], locale: string): RegistryFormSection[] => {
  const t = aiSettingsMessages.resolve([locale]).t;
  const { general, jobs, tools } = AI_SETTINGS_KEYS;
  const named = Object.values(AI_SETTINGS_KEYS).flat();
  const groups: Record<AiSettingsSection, RegistryFormSection[]> = {
    general: [
      { title: t.cloudAi, keys: general.slice(0, 3) },
      { title: t.context, keys: general.slice(3, 5) },
      { title: t.groupLiveDictation, keys: general.slice(5, 7) },
      { title: t.groupWorkflows, keys: general.slice(7) },
      // AI settings no section names (a newer release) keep a place under General
      { title: t.groupMore, keys: keys.filter((key) => !named.includes(key)) },
    ],
    jobs: [
      { title: t.groupEnrichment, keys: jobs.slice(0, 2) },
      { title: t.groupPersonalization, keys: jobs.slice(2, 5) },
      { title: t.groupCompaction, keys: jobs.slice(5) },
    ],
    tools: [
      { title: t.webTools, keys: tools.slice(0, 1) },
      { title: t.groupOpenAiApi, keys: tools.slice(1) },
    ],
  };
  return groups[section].filter((group) => group.keys.some((key) => keys.includes(key)));
};

/** The enrichment state of background jobs, its times worded by the server so both renders agree. */
const enrichmentView = (overview: Awaited<ReturnType<typeof aiConversations.getEnrichmentOverview>>, word: (iso: string) => string) => ({
  ...overview,
  oldestDirty: overview.oldestDirtyAt ? word(overview.oldestDirtyAt) : null,
  lastRun: overview.lastRunAt ? word(overview.lastRunAt) : null,
  recentRuns: overview.recentRuns.map((run) => ({ ...run, when: word(run.createdAt) })),
});

/**
 * General, background jobs and tools: the section's AI registry settings with their latest changes by a person, and
 * for jobs the enrichment state and the built-in task prompts.
 */
export const loadAiSettings = async (input: AiPageInput, section: AiSettingsSection) => {
  const [all, overview] = await Promise.all([
    buildEntries("ai", input.locale),
    section === "jobs" ? aiConversations.getEnrichmentOverview() : Promise.resolve(null),
  ]);
  const entries = aiSectionEntries(all, section, input.locale);
  const word = (iso: string) => formatDateTime(iso, input.dates);
  return {
    section,
    entries,
    sections: aiSettingsSections(
      section,
      entries.map((entry) => entry.key),
      input.locale,
    ),
    recent: recentChanges(entries, input.locale, word),
    enrichment: overview ? enrichmentView(overview, word) : null,
    prompts: section === "jobs" ? AI_BACKGROUND_TASK_PROMPTS : undefined,
    showJobsLink: input.showAiJobsLink,
  };
};

export type AiSettingsData = Awaited<ReturnType<typeof loadAiSettings>>;
export type AiEnrichmentView = NonNullable<AiSettingsData["enrichment"]>;
