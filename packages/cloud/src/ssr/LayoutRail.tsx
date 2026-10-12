import { useLocale } from "@k2b/ui";
import { createEffect } from "solid-js";
import { AppLaunchpadButton, setAppLaunchpadContext } from "./app-launchpad";
import GlobalSearchTrigger from "./GlobalSearchTrigger";
import LayoutHelpTrigger from "./LayoutHelpTrigger";
import ProfilePreferences from "./ProfilePreferences";
import { platformMessages } from "./platform-messages";
import RailApps from "./RailApps";
import type { RailApp } from "./rail-navigation";
import { useShellData } from "./shell-data";
export type LayoutAppLink = RailApp;

export default function LayoutRail(props: { currentPath: string }) {
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (!data?.rail || !data.profile) return null;
  const profile = { name: data.profile.name, theme: data.theme, ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}) };
  createEffect(() => setAppLaunchpadContext(data.apps, data.legalLinks, profile));
  return (
    <aside class="layout-rail hidden w-10 shrink-0 flex-col md:flex">
      <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
        <a href="/" aria-label={t().home}>
          <img src="/branding/logo" alt="Logo" class="h-5 w-5" />
        </a>
      </div>
      <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label={t().apps}>
        <RailApps apps={data.apps} settings={data.rail} currentPath={props.currentPath} />
        <AppLaunchpadButton profile={profile} apps={data.apps} legalLinks={data.legalLinks} variant="rail" label={t().openApps} />
        <div class="mt-auto shrink-0 flex flex-col items-center gap-1">
          <GlobalSearchTrigger variant="rail" />
          <LayoutHelpTrigger variant="rail" />
          <ProfilePreferences
            appHref={data.profile.appHref}
            avatarSrc={data.profile.avatarSrc}
            initialTheme={data.theme}
            name={data.profile.name}
          />
        </div>
      </nav>
    </aside>
  );
}
