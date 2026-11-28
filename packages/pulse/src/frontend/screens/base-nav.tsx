import { navigateTo } from "@k2b/ssr/nav";
import type { NavGroup, NavItem, NavSearch } from "@k2b/ui/v2";
import { type Accessor, createSignal, type JSX, onCleanup } from "solid-js";
import type { PulseBaseNav, PulseNav } from "../../contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { NewBaseDialog } from "./base-lifecycle";
import { useScreenMessages } from "./messages";
import { baseColor, iconName } from "./store-state";

export const baseHref = (baseId: string, view: "sources" | "sql" | "queries" | "settings" = "sources") =>
  `/app/pulse/${encodeURIComponent(baseId)}${view === "sources" ? "" : `/${view}`}`;

/** How long the sidebar's search waits after the last key before it asks the server for bases beyond the loaded ones. */
export const NAV_SEARCH_DEBOUNCE_MS = 250;

const navItem = (base: PulseBaseNav, currentId: string): NavItem => ({
  label: base.name,
  icon: iconName(base.icon),
  color: baseColor(base.color),
  href: baseHref(base.id),
  current: base.id === currentId,
  // a store that needs attention, a deletion that runs or stopped: the dot says it where the base is named
  dot: base.state === "failed" || base.state === "deletion-failed" ? "bad" : base.state === "deleting" ? "running" : undefined,
});

type Words = { bases: string; newBase: string; deleting: string; noMatch: string; searchFailed: string };

/**
 * The sidebar's groups: the bases with "Neue Basis" as their deed (the open one always among them), and for their
 * admins the bases whose deletion runs or failed, each leading to its page where the deletion is followed or resumed.
 * While a search finds nothing the bases' group says so and clears the search; a failed search offers its retry.
 */
export const baseNavGroups = (
  nav: PulseNav,
  currentId: string,
  words: Words,
  deeds: { onNew: () => void; search?: { empty: boolean; failed: boolean; clear: () => void; retry: () => void } },
): NavGroup[] => {
  const search = deeds.search;
  // k2b-ui gap: a Nav search has no state of its own for "no match" or "failed"; one entry of the group says it
  const note: NavItem[] = search?.failed
    ? [{ label: words.searchFailed, icon: "refresh", onClick: search.retry }]
    : search?.empty
      ? [{ label: words.noMatch, icon: "search-off", onClick: search.clear }]
      : [];
  return [
    {
      label: words.bases,
      action: { label: words.newBase, icon: "plus", onClick: deeds.onNew },
      items: [...nav.bases.map((base) => navItem(base, currentId)), ...note],
    },
    ...(nav.deleting.length > 0 ? [{ label: words.deleting, items: nav.deleting.map((base) => navItem(base, currentId)) }] : []),
  ];
};

const matching = (bases: readonly PulseBaseNav[], words: string) => {
  const needle = words.toLowerCase();
  return bases.filter((base) => base.name.toLowerCase().includes(needle));
};

/**
 * The sidebar of Pulse's pages: the bases as places, "Neue Basis" as the deed of their group, and a search over all
 * bases. The search filters the loaded bases at once; after `NAV_SEARCH_DEBOUNCE_MS` it asks the server for the first
 * matches among all of them (`GET /api/pulse/nav?q=`), and a newer word cancels the older question.
 */
export const createBaseNav = (nav: PulseNav, currentId: Accessor<string>) => {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const [creating, setCreating] = createSignal(false);
  const [query, setQuery] = createSignal("");
  // the server's answer and the words it answers; it keeps serving while the words only grow
  const [found, setFound] = createSignal<{ words: string; nav: PulseNav } | null>(null);
  const [asking, setAsking] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let question: AbortController | undefined;
  const stop = () => {
    clearTimeout(timer);
    question?.abort();
    question = undefined;
  };
  onCleanup(stop);

  const ask = async (words: string) => {
    const controller = new AbortController();
    question = controller;
    setAsking(true);
    try {
      const answer = await jsonFetch<PulseNav>(`/api/pulse/nav?q=${encodeURIComponent(words)}`, { signal: controller.signal });
      if (question === controller) setFound({ words, nav: answer });
    } catch {
      if (question === controller) setFailed(true);
    } finally {
      if (question === controller) setAsking(false);
    }
  };
  const search = (value: string) => {
    setQuery(value);
    stop();
    setFailed(false);
    const words = value.trim();
    setAsking(false);
    if (!words) {
      setFound(null);
      return;
    }
    // until the server answered, "no match" would only be the loaded bases' word
    setAsking(true);
    timer = setTimeout(() => void ask(words), NAV_SEARCH_DEBOUNCE_MS);
  };

  // what the groups show: everything loaded without a search; with one, the matches among the newest answer that
  // still covers the words (the server's answer for them, or one for fewer words), else among the loaded bases
  const shown = (): PulseNav => {
    const words = query().trim();
    if (!words) return nav;
    const answer = found();
    const pool = answer && words.toLowerCase().includes(answer.words.toLowerCase()) ? answer.nav : nav;
    return { bases: matching(pool.bases, words), deleting: matching(pool.deleting, words) };
  };
  const groups = () => {
    const now = shown();
    const asked = query().trim();
    return baseNavGroups(
      now,
      currentId(),
      {
        bases: words().bases,
        newBase: t().newBase,
        deleting: words().deletingTitle,
        noMatch: t().noMatchingBases,
        searchFailed: words().navSearchFailed,
      },
      {
        onNew: () => setCreating(true),
        search: {
          empty: Boolean(asked) && !asking() && now.bases.length === 0 && now.deleting.length === 0,
          failed: Boolean(asked) && failed(),
          clear: () => search(""),
          retry: () => {
            setFailed(false);
            void ask(asked);
          },
        },
      },
    );
  };
  // k2b-ui gap: the phone's menu (V2WorkspaceNavigation) lists the groups without the Nav's search, so on the phone the
  // bases beyond the first NAV_BASES stay out of reach until the switcher with its search (#4476) lands there
  const navSearch = (): NavSearch => ({
    label: t().searchBasesPlaceholder,
    value: query(),
    onInput: search,
    onKeyDown: (event) => {
      if (event.key === "Escape" && query()) {
        event.preventDefault();
        search("");
      }
    },
  });
  const dialog = (): JSX.Element => (
    <NewBaseDialog open={creating()} onOpenChange={setCreating} onCreated={(base) => navigateTo(baseHref(base.id))} />
  );
  return { groups, search: navSearch, dialog };
};
