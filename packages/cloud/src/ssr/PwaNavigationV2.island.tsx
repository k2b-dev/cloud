import { Icon, Nav } from "@k2b/ui/v2";
import { For, onCleanup, onMount, Show } from "solid-js";
import { appBadgeCount, watchAppBadges } from "./app-badges";

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
  /** The tab's title while its page loads, where it differs from the label (Start: the installation). */
  title?: string;
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
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  const count = (route: string | undefined) => shown(appBadgeCount({ endpoint: route }));
  const item = (entry: PwaNavEntry) => ({
    label: entry.label,
    icon: entry.icon,
    href: entry.href,
    current: entry.current,
    get count() {
      return count(entry.badge ?? entry.summary);
    },
  });
  return (
    <>
      <div class="pwa-v2-nav">
        <Nav
          title={props.title}
          icon="cloud"
          groups={[{ items: [item(props.start)] }, { label: props.appsLabel, items: props.parts.map(item) }]}
          foot={[item(props.settings)]}
        />
      </div>
      <Show when={props.tabs.length > 0}>
        <nav class="pwa-v2-tabs" aria-label={props.tabsLabel}>
          <For each={props.tabs}>
            {(tab) => (
              <a class="pwa-v2-tab" href={tab.href} title={tab.title} aria-current={tab.current ? "page" : undefined}>
                <Icon name={tab.icon} />
                <span class="pwa-v2-tab-label">{tab.label}</span>
                {/* after the label, so the tab reads "Chat 3"; it stands at the icon's top end */}
                <Show when={count(tab.badge)}>{(figure) => <span class="pwa-v2-tab-count">{figure()}</span>}</Show>
              </a>
            )}
          </For>
        </nav>
      </Show>
    </>
  );
}
