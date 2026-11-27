import { navigateTo } from "@k2b/ssr/nav";
import type { NavGroup, NavItem } from "@k2b/ui/v2";
import { type Accessor, createSignal, type JSX } from "solid-js";
import type { PulseBaseNav, PulseNav } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { NewBaseDialog } from "./base-lifecycle";
import { useScreenMessages } from "./messages";
import { baseColor, iconName } from "./store-state";

export const baseHref = (baseId: string, view: "sources" | "sql" | "queries" | "settings" = "sources") =>
  `/app/pulse/${encodeURIComponent(baseId)}${view === "sources" ? "" : `/${view}`}`;

const navItem = (base: PulseBaseNav, currentId: string): NavItem => ({
  label: base.name,
  icon: iconName(base.icon),
  color: baseColor(base.color),
  href: baseHref(base.id),
  current: base.id === currentId,
  // a store that needs attention: the dot says it where the base is named
  dot: base.state === "failed" ? ("bad" as const) : undefined,
});

/** The sidebar's groups: all bases first, then the bases with "Neue Basis" as their deed (the open one always among them). */
export const baseNavGroups = (
  nav: PulseNav,
  currentId: string,
  words: { allBases: string; bases: string; newBase: string },
  onNew: () => void,
): NavGroup[] => [
  // "" is the list of all bases itself
  { items: [{ label: words.allBases, icon: "layout-grid", href: "/app/pulse", current: currentId === "" }] },
  {
    label: words.bases,
    action: { label: words.newBase, icon: "plus", onClick: onNew },
    items: nav.bases.map((base) => navItem(base, currentId)),
  },
];

/** The sidebar of Pulse's pages: the bases as places, and "Neue Basis" as the deed of their group. */
export const createBaseNav = (nav: PulseNav, currentId: Accessor<string>, onNew?: () => void) => {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const [creating, setCreating] = createSignal(false);
  const groups = () =>
    baseNavGroups(
      nav,
      currentId(),
      { allBases: words().allBases, bases: words().bases, newBase: t().newBase },
      onNew ?? (() => setCreating(true)),
    );
  const dialog = (): JSX.Element => (
    <NewBaseDialog open={creating()} onOpenChange={setCreating} onCreated={(base) => navigateTo(baseHref(base.id))} />
  );
  return { groups, dialog };
};
