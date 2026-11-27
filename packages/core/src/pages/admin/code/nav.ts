import { adminNavigation } from "@k2b/cloud/ssr";
import type { NavProps } from "@k2b/ui/v2";
import type { CodeAdminSummary } from "../../../code/admin";
import { CODE_AREA_SECTIONS, CODE_SECTION_ICON, type CodeAreaSection, codeAreaHref } from "./area";
import { codeAdminMessages } from "./messages";

/**
 * The admin bar with the sections of Code one level in under its entry, the open one current. Approvals, groups and
 * cleanup carry their count right-aligned; open page reports put a dot on all automations, where each automation lists
 * its own. The number of all automations is no work, so it stays the statement of their list.
 */
export const codeNav = (
  c: Parameters<typeof adminNavigation>[0],
  locale: string,
  current: CodeAreaSection,
  summary: CodeAdminSummary | null,
): NavProps => {
  const t = codeAdminMessages.resolve([locale]).t;
  const href = (section: CodeAreaSection) => codeAreaHref({ sec: section });
  const nav = adminNavigation(
    c,
    CODE_AREA_SECTIONS.map((section) => ({
      label: t.sectionLabel({ s: section }),
      icon: CODE_SECTION_ICON[section],
      href: href(section),
      current: section === current,
      ...(section === "code" && summary?.reports ? { dot: "warn" as const } : {}),
    })),
  );
  // The admin bar's sections take no count; the counts the page already read join their entries here.
  const counts = new Map<string, number | undefined>([
    [href("approvals"), summary?.approvals],
    [href("groups"), summary?.groups],
    [href("cleanup"), summary?.cleanup],
  ]);
  return {
    ...nav,
    groups: nav.groups.map((group) => ({
      ...group,
      items: group.items.map((item) => {
        const count = item.nested && item.href ? counts.get(item.href) : undefined;
        return count ? { ...item, count } : item;
      }),
    })),
  };
};
