import { aiConversations } from "@k2b/cloud/ai";
import { AI_BACKGROUND_TASK_PROMPTS } from "@k2b/cloud/ai/admin";
import { buildEntries } from "../settings/entries";
import type { AiPageInput } from "./page-input";

export type AiSettingsSection = "general" | "jobs" | "tools";

/** General, background jobs and tools: the AI registry settings, and for jobs the enrichment state and built-in prompts. */
export const loadAiSettings = async (input: AiPageInput, section: AiSettingsSection) => {
  const [entries, enrichment] = await Promise.all([
    buildEntries("ai", input.locale),
    section === "jobs" ? aiConversations.getEnrichmentOverview() : Promise.resolve(null),
  ]);
  return {
    section,
    entries,
    enrichment,
    prompts: section === "jobs" ? AI_BACKGROUND_TASK_PROMPTS : undefined,
    showJobsLink: input.showAiJobsLink,
  };
};

export type AiSettingsData = Awaited<ReturnType<typeof loadAiSettings>>;
