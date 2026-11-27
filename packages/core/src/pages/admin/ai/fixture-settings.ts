/** Invented AI registry settings for the AI area's browser fixture (General, Background jobs, Tools). */
import type { AiFixtureApi, AiFixtureInput } from "./fixture-types";
import type { AiSettingsData } from "./settings-data";

export const settingsFixture = (input: AiFixtureInput): AiSettingsData => {
  const section = (["general", "jobs", "tools"] as const).find((name) => name === input.params.get("sec")) ?? "general";
  return { section, entries: [], enrichment: null, prompts: undefined, showJobsLink: true };
};

export const settingsApi: AiFixtureApi = () => undefined;
