import { useLocale } from "@k2b/ui";
import CloudShell from "./CloudShell.island";
import { platformMessages } from "./platform-messages";
import type { RailApp } from "./rail-navigation";
import { useShellData } from "./shell-data";
export type LayoutAppLink = RailApp;

/**
 * The rail frame and Home stay server markup; only the navigation is interactive. `data-rail-names` carries the
 * person's setting, so the first frame already has the width the stylesheet gives it on wide windows.
 */
export default function LayoutRail(props: { currentPath: string; panelOpen?: boolean; name: string }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const data = useShellData();
  return (
    <aside
      class="layout-rail w-14 shrink-0 flex-col max-md:hidden md:flex"
      data-rail-names={data?.rail?.showNames === false ? undefined : ""}
    >
      <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
        <a href="/" aria-label={`${props.name}, ${t().home}`}>
          <img src="/branding/logo" alt="Logo" class="h-5 w-5" />
          <span class="rail-item-label">{props.name}</span>
        </a>
      </div>
      <CloudShell slot="rail" currentPath={props.currentPath} panelOpen={props.panelOpen} />
    </aside>
  );
}
