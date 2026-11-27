import type { AiAdminOverview } from "@k2b/cloud/ai/admin";
import { AI_MODEL_CLASSES } from "@k2b/cloud/shared";
import { adminNavigation } from "@k2b/cloud/ssr";
import { AI_AREA_SECTIONS, type AiAreaSection, aiAreaHref } from "./area";
import { AI_SECTION_ICON, aiSectionLabel } from "./frame";
import { aiProviderState } from "./presentation";

export { aiSectionLabel };

/**
 * The admin bar with the AI sections one level in under its entry, the open one current. A broken provider marks
 * "Providers", a class without any model "Model classes"; the overview the page reads anyway says so, nothing more.
 */
export const aiNav = (
  c: Parameters<typeof adminNavigation>[0],
  locale: string,
  current: AiAreaSection,
  overview?: AiAdminOverview | null,
) => {
  const broken = overview?.providers.some((provider) => {
    const state = aiProviderState(provider);
    return state === "badkey" || state === "unreachable";
  });
  const unassigned = overview && overview.providers.length > 0 && AI_MODEL_CLASSES.some((slot) => !overview.effective[slot]?.variantId);
  return adminNavigation(
    c,
    AI_AREA_SECTIONS.map((section) => ({
      label: aiSectionLabel(locale, section),
      icon: AI_SECTION_ICON[section],
      href: aiAreaHref({ sec: section }),
      current: section === current,
      ...(section === "providers" && broken ? { dot: "bad" as const } : {}),
      ...(section === "classes" && unassigned ? { dot: "warn" as const } : {}),
    })),
  );
};
