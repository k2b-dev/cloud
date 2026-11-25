import { adminNavigation } from "@k2b/cloud/ssr";
import type { NavProps } from "@k2b/ui/v2";
import { type Attention, observabilityGroups } from "./ObservabilityArea";

type NavContext = Parameters<typeof adminNavigation>[0] & Parameters<typeof observabilityGroups>[0];

/**
 * The admin bar of a v2 page in the Observability area: the area's sections, and the links other apps add to it, stand
 * one level in under "Observability"; a section that needs attention carries a dot.
 */
export const observabilityAdminNav = (c: NavContext, locale: string, attention: Attention, current: string): NavProps =>
  adminNavigation(
    c,
    observabilityGroups(c, locale, attention).flatMap((group) =>
      group.items.map((item) => ({
        label: item.label,
        icon: item.icon,
        href: item.href,
        current: item.id === current,
        ...(item.mark === "error" ? { dot: "bad" as const } : item.mark === "warning" ? { dot: "warn" as const } : {}),
      })),
    ),
  );
