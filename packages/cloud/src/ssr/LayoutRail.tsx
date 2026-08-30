import type { CloudTheme } from "../shared/theme";
import AppLaunchpad, { type AppLaunchpadApp } from "./AppLaunchpad.island";
import { appAccentStyle } from "./app-appearance";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import GlobalSearchTrigger from "./GlobalSearchTrigger.island";
import HotkeysHelpRail from "./HotkeysHelpRail.island";
import ProfilePreferences from "./ProfilePreferences.island";

export type LayoutAppLink = {
  id: string;
  iconClass: string;
  label: string;
  href: string;
  match: string;
  description?: string;
  accent?: string;
};

type LayoutRailProps = {
  accent?: string;
  appsLabel: string;
  homeLabel: string;
  launchpadApps: AppLaunchpadApp[];
  legalLinks: Array<{ label: string; href: string; icon?: string }>;
  openAppsLabel: string;
  pathname: string;
  primaryApps: LayoutAppLink[];
  profileAvatarSrc?: string;
  profileName: string;
  searchHelpApps: GlobalSearchHelpApp[];
  theme: CloudTheme;
};

const active = (pathname: string, match: string): boolean => pathname.startsWith(match);
const jsonScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export default function LayoutRail(props: LayoutRailProps) {
  return (
    <>
      <AppLaunchpad apps={props.launchpadApps} legalLinks={props.legalLinks} />
      <script id="cloud-app-launchpad-data" type="application/json">
        {jsonScript({ apps: props.launchpadApps, legalLinks: props.legalLinks })}
      </script>
      <aside class="layout-rail hidden w-10 shrink-0 flex-col md:flex">
        <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
          <a href="/" aria-label={props.homeLabel}>
            <img src="/branding/logo" alt="Logo" class="h-5 w-5" />
          </a>
        </div>
        <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label={props.appsLabel}>
          {props.primaryApps.map((app) => (
            <a
              href={app.href}
              class={`rail-item ${active(props.pathname, app.match) ? "rail-item-active" : ""}`}
              aria-label={app.label}
              aria-current={active(props.pathname, app.match) ? "page" : undefined}
              title={app.label}
              style={appAccentStyle(app.accent)}
            >
              <i class={`${app.iconClass} text-base`} />
            </a>
          ))}
          <AppLaunchpad apps={props.launchpadApps} legalLinks={props.legalLinks} variant="rail" label={props.openAppsLabel} />
          <div class="mt-auto flex flex-col items-center gap-1">
            <GlobalSearchTrigger variant="rail" searchHelpApps={props.searchHelpApps} />
            <HotkeysHelpRail variant="rail" registerHotkey searchHelpApps={props.searchHelpApps} accent={props.accent} />
            <ProfilePreferences avatarSrc={props.profileAvatarSrc} initialTheme={props.theme} name={props.profileName} placement="rail" />
          </div>
        </nav>
      </aside>
    </>
  );
}
