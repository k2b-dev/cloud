import { TabBar, type TabBarItem, useLocale } from "@k2b/ui";
import { platformMessages } from "./platform-messages";
import { phoneBarLinks, projectRailNavigation, railLinkActive } from "./rail-navigation";
import { useShellData } from "./shell-data";

/** Start and four apps fill the bar's five places. */
const BAR_APPS = 4;

/**
 * The signed-in phone's bottom bar: Start and the person's first apps in their rail order, floating on the app
 * gradient above the content card. Server markup only, so it stands in its final place before any island mounts. The
 * place of the app's primary action beside it stays free. From 768 px the rail takes over and the bar is hidden.
 */
export default function LayoutTabBar(props: { currentPath: string }) {
  const data = useShellData();
  const locale = useLocale();
  if (!data?.rail) return null;
  const t = platformMessages.resolve([locale()]).t;
  const links = phoneBarLinks(projectRailNavigation(data.apps, data.rail, locale()), props.currentPath, BAR_APPS);
  const home = new URL(props.currentPath, "https://cloud.invalid").pathname === "/";
  const items: TabBarItem[] = [
    { id: "home", label: t.home, icon: "ti ti-home", href: "/", current: home },
    ...links.map((link) => ({
      id: link.id,
      label: link.label,
      icon: link.iconClass,
      href: link.href,
      current: !home && railLinkActive(link, props.currentPath),
    })),
  ];
  return (
    <div class="cloud-tab-bar">
      <div class="cloud-tab-bar__row">
        <TabBar variant="floating" label={t.apps} items={items} />
      </div>
    </div>
  );
}
