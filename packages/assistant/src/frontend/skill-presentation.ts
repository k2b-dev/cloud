import type { AiSkillSummary } from "@k2b/cloud/ai";
import { assistantMessages } from "./messages";

// App ownership is part of the identity: a user Skill with the same name keeps its own copy.
const builtInSkillKeys = new Map(
  Object.entries({
    "assistant.code-authoring": { title: "skillCodeAuthoringTitle", description: "skillCodeAuthoringDescription" },
    "assistant.assistant-code-mode": { title: "skillCodeModeTitle", description: "skillCodeModeDescription" },
    "assistant.assistant-data-analysis": { title: "skillDataAnalysisTitle", description: "skillDataAnalysisDescription" },
    "assistant.cloud-assistant": { title: "skillCloudAssistantTitle", description: "skillCloudAssistantDescription" },
    "assistant.skill-creator": { title: "skillSkillCreatorTitle", description: "skillSkillCreatorDescription" },
    "chat.cloud-chat": { title: "skillCloudChatTitle", description: "skillCloudChatDescription" },
    "contacts.cloud-contacts": { title: "skillCloudContactsTitle", description: "skillCloudContactsDescription" },
    "grids.cloud-grids": { title: "skillCloudGridsTitle", description: "skillCloudGridsDescription" },
    "mail.cloud-mail": { title: "skillCloudMailTitle", description: "skillCloudMailDescription" },
    "notebooks.cloud-notebooks": { title: "skillCloudNotebooksTitle", description: "skillCloudNotebooksDescription" },
    "pulse.cloud-pulse": { title: "skillCloudPulseTitle", description: "skillCloudPulseDescription" },
    "spaces.cloud-spaces": { title: "skillCloudSpacesTitle", description: "skillCloudSpacesDescription" },
    "weather.cloud-weather": { title: "skillCloudWeatherTitle", description: "skillCloudWeatherDescription" },
  } as const),
);
const builtInSkillNames = new Set([...builtInSkillKeys.keys()].map((key) => key.slice(key.indexOf(".") + 1)));

/** Recent resources have no source identity; only these names need an authorized lookup. */
export const needsAssistantSkillTranslation = (name: string, locale: string) =>
  builtInSkillNames.has(name) && assistantMessages.resolve([locale]).locale !== assistantMessages.baseLocale;

/** Human-facing menu copy only; source descriptions still drive model discovery. */
export const assistantSkillPresentation = (skill: Pick<AiSkillSummary, "name" | "description" | "source">, locale: string) => {
  const keys = skill.source && builtInSkillKeys.get(`${skill.source.appId}.${skill.name}`);
  if (!keys) return { title: skill.name, description: skill.description };
  const { locale: resolvedLocale, t } = assistantMessages.resolve([locale]);
  const base = assistantMessages.resolve([assistantMessages.baseLocale]).t;
  // English always reflects the installed revision. A changed description is custom copy (or a
  // newer app revision), for which this translation no longer applies.
  if (resolvedLocale === assistantMessages.baseLocale || skill.description !== base[keys.description])
    return { title: skill.name, description: skill.description };
  return { title: t[keys.title], description: t[keys.description] };
};
