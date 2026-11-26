import type { NavItem, NavProps } from "@k2b/ui/v2";
import { getLocale } from "../server/locale";
import { activeAdminLink } from "./admin-active-link";
import { buildAdminGroups } from "./admin-navigation";
import { platformMessages } from "./platform-messages";
import { getDisplayRuntimeContext, type RuntimeContext } from "./runtime";

type AdminNavContext = {
  get(key: "runtime"): RuntimeContext;
  get(key: "adminCodeApprovals"): number | undefined;
  get(key: "settings"): Record<string, any> | undefined;
  req: { raw: { headers: Headers; url: string } };
};

/** One section of the open admin area, such as "Modelle" of AI; it stands one level in under the area's entry. */
export type AdminNavigationSection = {
  label: string;
  /** A Tabler name without `ti-`, such as `database`. */
  icon: string;
  href: string;
  current?: boolean;
  /** The section needs attention. */
  dot?: "warn" | "bad";
};

/** "ti ti-apps", "ti-apps" and "apps" are all the v2 name "apps". */
const v2Icon = (icon: string) => icon.replace(/^ti\s+/, "").replace(/^ti-/, "");

/**
 * The admin bar for a v2 page's `Nav` (and its `V2WorkspaceNavigation` on the phone): the same groups and order as
 * the v1 admin sidebar, the entry of the open page current. An area page passes its `sections`: they stand one level
 * in under the area's entry, so the way to the other admin areas stays in the same sidebar. The result is plain data,
 * so a page hands it to its island.
 */
export const adminNavigation = (c: AdminNavContext, sections: readonly AdminNavigationSection[] = []): NavProps => {
  const locale = getLocale(c);
  const t = platformMessages.resolve([locale]).t;
  const url = new URL(c.req.raw.url);
  const groups = buildAdminGroups(getDisplayRuntimeContext(c).apps, locale, { codeApprovals: c.get("adminCodeApprovals") });
  const active = activeAdminLink(
    `${url.pathname}${url.search}`,
    groups.flatMap((group) => group.links),
  )?.href;
  return {
    title: t.admin,
    icon: "settings",
    groups: groups.map((group) => ({
      ...(group.label ? { label: group.label } : {}),
      items: group.links.flatMap((link): NavItem[] => {
        const open = link.href === active;
        const entry: NavItem = {
          label: link.label,
          icon: v2Icon(link.icon),
          href: link.href,
          ...(open && sections.every((section) => !section.current) ? { current: true } : {}),
          ...(link.waiting ? { count: link.waiting.count } : {}),
        };
        if (!open) return [entry];
        return [
          entry,
          ...sections.map((section) => ({
            label: section.label,
            icon: v2Icon(section.icon),
            href: section.href,
            nested: true,
            ...(section.current ? { current: true } : {}),
            ...(section.dot ? { dot: section.dot } : {}),
          })),
        ];
      }),
    })),
  };
};
