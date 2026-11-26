import { useLocale } from "@k2b/ui";
import { Icon, Nav } from "@k2b/ui/v2";
import { For, onCleanup, onMount, Show } from "solid-js";
import { appBadgeCount, watchAppBadges } from "./app-badges";
import { pwaMessages } from "./pwa-messages";

/** One place of the Cloud app, as the server knows it. */
export type PwaNavEntry = {
  id: string;
  label: string;
  /** A Tabler icon name, such as `home`. */
  icon: string;
  href: string;
  current: boolean;
  /** The part's `pwa.badge` route: a count that calls for attention, also on its tab. */
  badge?: string;
  /** The part's `pwa.summary` route: a count that stays quiet in the sidebar; shown only without a badge. */
  summary?: string;
};

export type PwaNavigationV2Props = {
  /** The installation's name. */
  title: string;
  start: PwaNavEntry;
  /** The heading over the parts. */
  appsLabel: string;
  parts: PwaNavEntry[];
  settings: PwaNavEntry;
  /** The name of the tab bar. */
  tabsLabel: string;
  /** Start and the first parts as tabs below 48rem; none without parts. */
  tabs: PwaNavEntry[];
  /** Every count route of the page, read once a minute like the web's. */
  endpoints: string[];
};

const shown = (count: number) => (count > 99 ? "99+" : count > 0 ? String(count) : undefined);

/**
 * The navigation of a v2 Cloud app page (`PwaLayout ui="v2"`): from 48rem a v2 `Nav` with Start, every part with its
 * count and Settings at the foot; below 48rem a tab bar of Start and the first parts, a badge's count on its tab. One
 * island for both, for the counts the browser reads; its two parts take their places in the frame's grid.
 */
export default function PwaNavigationV2(props: PwaNavigationV2Props) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  const count = (route: string | undefined) => shown(appBadgeCount({ endpoint: route }));
  // The figure is a mark; the tab's name says it in words, no more than the "99+" it shows.
  const phrase = (route: string | undefined) => {
    const value = appBadgeCount({ endpoint: route });
    return value > 99 ? t().unreadMany : t().unread({ count: value });
  };
  const item = (entry: PwaNavEntry) => ({
    label: entry.label,
    icon: entry.icon,
    href: entry.href,
    current: entry.current,
    // k2b-ui gap: `Nav` has no count that calls for attention (v1's unread badge); a badge shows as the quiet count.
    get count() {
      return count(entry.badge ?? entry.summary);
    },
  });
  return (
    <>
      <div class="pwa-v2-nav">
        <Nav
          title={props.title}
          // k2b-ui gap: `Nav`'s title takes a Tabler icon only, no brand logo (v1 showed `/branding/logo`).
          icon="cloud"
          groups={[{ items: [item(props.start)] }, { label: props.appsLabel, items: props.parts.map(item) }]}
          foot={[item(props.settings)]}
        />
      </div>
      <Show when={props.tabs.length > 0}>
        {/* k2b-ui gap: v2 has no bottom tab bar; this one is Cloud markup on v2 tokens (styles/pwa-layout.css). */}
        <nav class="pwa-v2-tabs" aria-label={props.tabsLabel}>
          <For each={props.tabs}>
            {(tab) => (
              <a class="pwa-v2-tab" href={tab.href} aria-current={tab.current ? "page" : undefined}>
                <Icon name={tab.icon} />
                <span class="pwa-v2-tab-label">{tab.label}</span>
                {/* a badge calls for attention: a round figure at the icon's top end, and its words for the tab's name */}
                <Show when={count(tab.badge)}>
                  {(figure) => (
                    <>
                      <span class="pwa-v2-tab-count" aria-hidden="true">
                        {figure()}
                      </span>
                      <span class="pwa-v2-tab-phrase">{phrase(tab.badge)}</span>
                    </>
                  )}
                </Show>
              </a>
            )}
          </For>
        </nav>
      </Show>
    </>
  );
}
