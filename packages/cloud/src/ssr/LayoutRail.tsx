import { useLocale } from "@k2b/ui";
import CloudShell from "./CloudShell.island";
import { platformMessages } from "./platform-messages";
import type { RailApp } from "./rail-navigation";
export type LayoutAppLink = RailApp;

/** The rail frame and Home stay server markup; only the navigation is interactive. */
export default function LayoutRail(props: { currentPath: string }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  return (
    <aside class="layout-rail hidden w-14 shrink-0 flex-col md:flex">
      <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
        <a href="/" aria-label={t().home}>
          <img src="/branding/logo" alt="Logo" class="h-5 w-5" />
        </a>
      </div>
      <CloudShell slot="rail" currentPath={props.currentPath} />
    </aside>
  );
}
