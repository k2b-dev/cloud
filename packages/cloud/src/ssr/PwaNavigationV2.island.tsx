import { Nav, TabBar } from "@k2b/ui/v2";
import { onCleanup, onMount, Show } from "solid-js";
import { appBadgeCount, watchAppBadges } from "./app-badges";

/** One place of the Cloud app, as the server knows it. */
export type PwaNavEntry = {
  id: string;
  label: string;
  /** A Tabler icon name, such as `home`. */
  icon: string;
  href: string;
  current: boolean;
  /** The part's `pwa.badge` route: a count that calls for attention, in the sidebar and on its tab. */
  badge?: string;
  /** The part's `pwa.summary` route: a quiet count in the sidebar. */
  summary?: string;
};

export type PwaNavigationV2Props = {
  /** The installation's name. */
  title: string;
  /** The installation's logo. */
  logo: string;
  start: PwaNavEntry;
  /** The heading over the parts. */
  appsLabel: string;
  parts: PwaNavEntry[];
  settings: PwaNavEntry;
  /** The name of the tab bar. */
  tabsLabel: string;
  /** Start and every part as tabs below 48rem: four, then "More" with the others; none without parts. */
  tabs: PwaNavEntry[];
  /** A screen of its own: the tab bar steps aside (`hidden`) and `setPwaScreen` brings it back in place. */
  screen?: boolean;
  /** Every count route of the page, read once a minute like the web's. */
  endpoints: string[];
};

/**
 * The navigation of a v2 Cloud app page (`PwaLayout ui="v2"`): from 48rem a v2 `Nav` with the installation's logo,
 * Start, every part and Settings at the foot; below 48rem a `TabBar` of Start and the parts. A part's badge is a count
 * that calls for attention in both, its summary a quiet count in the sidebar. One island for both, for the counts the
 * browser reads; its two parts take their places in the frame's grid.
 */
export default function PwaNavigationV2(props: PwaNavigationV2Props) {
  onMount(() => onCleanup(watchAppBadges(props.endpoints)));
  const read = (route: string | undefined) => (route ? appBadgeCount({ endpoint: route }) : 0);
  const item = (entry: PwaNavEntry) => ({
    label: entry.label,
    icon: entry.icon,
    href: entry.href,
    current: entry.current,
    get count() {
      const value = read(entry.summary);
      return value > 0 ? value : undefined;
    },
    get unread() {
      return read(entry.badge);
    },
  });
  return (
    <>
      <div class="pwa-v2-nav">
        <Nav
          title={props.title}
          icon="cloud"
          logo={props.logo}
          groups={[{ items: [item(props.start)] }, { label: props.appsLabel, items: props.parts.map(item) }]}
          foot={[item(props.settings)]}
        />
      </div>
      <Show when={props.tabs.length > 0}>
        <TabBar label={props.tabsLabel} items={props.tabs.map(item)} hidden={props.screen} />
      </Show>
    </>
  );
}
