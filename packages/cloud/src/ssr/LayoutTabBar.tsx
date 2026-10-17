import { TabBar, useLocale } from "@k2b/ui";
import CloudShell from "./CloudShell.island";
import { platformMessages } from "./platform-messages";
import { phoneBarItems, projectRailNavigation } from "./rail-navigation";
import { useShellData } from "./shell-data";

/**
 * The signed-in phone's bottom bar: Home and the person's first apps in their rail order, floating on the app
 * gradient above the content card. It is server markup, so it stands in its final place before any island mounts and
 * a link focused early keeps its focus. The shell's island beside it takes over only when the bar's content changes
 * in the browser: after the person saves their rail preferences, or for a link that matches the URL's fragment. The
 * place of the app's primary action beside it stays free. From 768 px the rail takes over and the bar is hidden.
 */
export default function LayoutTabBar(props: { currentPath: string }) {
  const data = useShellData();
  const locale = useLocale();
  if (!data?.rail) return null;
  const t = platformMessages.resolve([locale()]).t;
  const items = phoneBarItems(projectRailNavigation(data.apps, data.rail, locale()), props.currentPath, {
    label: t.home,
    path: data.home ?? "/",
  });
  return (
    <div class="cloud-tab-bar">
      <div class="cloud-tab-bar__row">
        <TabBar variant="floating" label={t.apps} items={items} />
        <CloudShell slot="bar" currentPath={props.currentPath} />
      </div>
    </div>
  );
}
