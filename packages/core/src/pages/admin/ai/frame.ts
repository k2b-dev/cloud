import { AI_AREA_PATH, type AiAreaSection } from "./area";
import { aiAreaMessages } from "./messages";

/** The symbol of each section, in the admin bar and wherever a section is named. */
export const AI_SECTION_ICON: Record<AiAreaSection, string> = {
  classes: "stairs-up",
  providers: "plug-connected",
  general: "adjustments",
  budgets: "gauge",
  jobs: "clock-bolt",
  tools: "tool",
  skills: "wand",
  projects: "folders",
  usage: "chart-histogram",
};

/** The section's name, as the admin bar and the head's path show it. */
export const aiSectionLabel = (locale: string, section: AiAreaSection): string => {
  const t = aiAreaMessages.resolve([locale]).t;
  return {
    classes: t.recs,
    providers: t.providers,
    general: t.general,
    budgets: t.budgets,
    jobs: t.jobs,
    tools: t.tools,
    skills: t.skills,
    projects: t.projects,
    usage: t.usage,
  }[section];
};

/** The first place of every AI section's path ("KI"), leading to the area's start. */
export const aiAreaLink = (locale: string) => ({ label: aiAreaMessages.resolve([locale]).t.aiArea, href: AI_AREA_PATH });

/**
 * The AI area's own colour, the v2 AI tone (`--k2-ai` in light), for what belongs to it: the hero's figure, charts,
 * the open object's head (identity B, rule 6: the content shows whose it is). A hex value, so the primitives derive
 * readable foregrounds in light and dark.
 */
export const AI_COLOR = "#8e1b6f";
