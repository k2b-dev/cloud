import type { RailPreferences } from "../contracts/rail-preferences";
import type { CloudTheme } from "../shared/theme";
import AppLaunchpad, { type AppLaunchpadApp } from "./AppLaunchpad.island";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import GlobalSearchTrigger from "./GlobalSearchTrigger.island";
import HotkeysHelpRail from "./HotkeysHelpRail.island";
import ProfilePreferences from "./ProfilePreferences.island";
import RailApps from "./RailApps.island";
import type { RailApp } from "./rail-navigation";
export type LayoutAppLink = RailApp;

type LayoutRailProps = {
  accent?: string;
  appsLabel: string;
  homeLabel: string;
  launchpadApps: AppLaunchpadApp[];
  legalLinks: Array<{ label: string; href: string; icon?: string }>;
  openAppsLabel: string;
  apps: RailApp[];
  railSettings: RailPreferences;
  currentUrl: string;
  profileAvatarSrc?: string;
  profileName: string;
  searchHelpApps: GlobalSearchHelpApp[];
  theme: CloudTheme;
};

const jsonScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export default function LayoutRail(props: LayoutRailProps) {
  return (
    <>
      <AppLaunchpad apps={props.launchpadApps} legalLinks={props.legalLinks} />
      <script id="cloud-app-launchpad-data" type="application/json">
        {jsonScript({ apps: props.launchpadApps, legalLinks: props.legalLinks })}
      </script>
      <script id="cloud-rail-data" type="application/json">
        {jsonScript({ apps: props.apps, settings: props.railSettings })}
      </script>
      <aside class="layout-rail hidden w-10 shrink-0 flex-col md:flex">
        <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
          <a href="/" aria-label={props.homeLabel}>
            <img src="/branding/logo" alt="Logo" class="h-5 w-5" />
          </a>
        </div>
        <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label={props.appsLabel}>
          <RailApps apps={props.apps} settings={props.railSettings} currentUrl={props.currentUrl} />
          <AppLaunchpad apps={props.launchpadApps} legalLinks={props.legalLinks} variant="rail" label={props.openAppsLabel} />
          <div class="mt-auto shrink-0 flex flex-col items-center gap-1">
            <GlobalSearchTrigger variant="rail" searchHelpApps={props.searchHelpApps} />
            <HotkeysHelpRail variant="rail" registerHotkey searchHelpApps={props.searchHelpApps} accent={props.accent} />
            <ProfilePreferences avatarSrc={props.profileAvatarSrc} initialTheme={props.theme} name={props.profileName} placement="rail" />
          </div>
        </nav>
      </aside>
    </>
  );
}
