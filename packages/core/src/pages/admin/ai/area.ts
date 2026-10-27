import { AI_MODEL_SLOTS, type AiModelSlot } from "@k2b/cloud/ai";

/** The AI area's sections. Each one is a row in the first column. */
export const AI_AREA_SECTIONS = ["classes", "providers", "general", "budgets", "jobs", "tools", "skills", "projects", "usage"] as const;
export type AiAreaSection = (typeof AI_AREA_SECTIONS)[number];

/** The selection the URL holds, so reload, back, and links return to the same place. */
export type AiAreaQuery = {
  sec?: AiAreaSection;
  /** Provider id in `providers`. */
  p?: string;
  /** Model id in `providers`. */
  m?: string;
  /** The provider's connection instead of a model. */
  pane?: "conn";
  /** Class or tool in `classes`. */
  slot?: AiModelSlot;
};

export const AI_AREA_PATH = "/admin/ai";

export const aiAreaHref = (query: AiAreaQuery, extra: Record<string, string> = {}): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) if (value) params.set(key, value);
  const search = params.toString();
  return search ? `${AI_AREA_PATH}?${search}` : AI_AREA_PATH;
};

export const parseAiAreaQuery = (query: Record<string, string | undefined>): AiAreaQuery => {
  const sec = AI_AREA_SECTIONS.find((section) => section === query.sec);
  const slot = AI_MODEL_SLOTS.find((candidate) => candidate === query.slot);
  if (!sec) return {};
  if (sec === "providers")
    return {
      sec,
      ...(query.p ? { p: query.p } : {}),
      ...(query.p && query.pane === "conn" ? { pane: "conn" } : query.p && query.m ? { m: query.m } : {}),
    };
  if (sec === "classes") return { sec, ...(slot ? { slot } : {}) };
  return { sec };
};

/** Sections whose content fills the second and third column together. */
export const isWideSection = (section: AiAreaSection | undefined): boolean =>
  section !== undefined && section !== "classes" && section !== "providers";

/** The deepest level the selection reaches; the workspace shows it and as many levels before it as fit. */
export const aiAreaLevel = (query: AiAreaQuery): "area" | "section" | "detail" => {
  if (query.m || query.pane || query.slot) return "detail";
  if (query.sec && (query.sec !== "providers" || query.p)) return "section";
  return "area";
};

/** Old `/admin/settings?tab=ai-*` addresses and the section that replaced each. */
export const AI_SETTINGS_TAB_SECTIONS: Record<string, AiAreaSection> = {
  ai: "general",
  "ai-general": "general",
  "ai-providers": "providers",
  "ai-quotas": "budgets",
  "ai-usage": "usage",
  "ai-skills": "skills",
  "ai-projects": "projects",
  "ai-jobs": "jobs",
};
