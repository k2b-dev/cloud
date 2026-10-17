import { useLocale } from "@k2b/ui";
import { createEffect } from "solid-js";
import { AppLaunchpadButton, setAppLaunchpadContext } from "./app-launchpad";
import GlobalSearchTrigger from "./GlobalSearchTrigger";
import LayoutBreadcrumbs from "./LayoutBreadcrumbs";
import LayoutHelpTrigger from "./LayoutHelpTrigger";
import LayoutPreferences from "./LayoutPreferences";
import type { LayoutBreadcrumb } from "./layout-runtime";
import ProfilePreferences from "./ProfilePreferences";
import { platformMessages } from "./platform-messages";
import RailApps from "./RailApps";
import ShellFocusToggle from "./ShellFocusToggle";
import { useShellData } from "./shell-data";

type CloudShellProps =
  | { slot: "rail"; currentPath: string }
  | { slot: "header"; authenticated: boolean; title?: string; launchpad: boolean; breadcrumbs?: LayoutBreadcrumb[] };

/**
 * The interactive part of the shell chrome. `LayoutRail` and `LayoutHeader`
 * own the frame and the plain links around it as server markup.
 */
export default function CloudShell(props: CloudShellProps) {
  return props.slot === "rail" ? <RailNavigation currentPath={props.currentPath} /> : <HeaderControls {...props} />;
}

function RailNavigation(props: { currentPath: string }) {
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (!data?.rail || !data.profile) return null;
  const profile = { name: data.profile.name, theme: data.theme, ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}) };
  createEffect(() => setAppLaunchpadContext(data.apps, data.legalLinks, profile));
  return (
    <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label={t().apps}>
      <ShellFocusToggle variant="rail" />
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
  );
}

/** The header's title and controls, between the server-rendered Home and Sign in. */
function HeaderControls(props: { authenticated: boolean; title?: string; launchpad: boolean; breadcrumbs?: LayoutBreadcrumb[] }) {
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (!data) return null;
  return (
    <>
      <div class="ml-2 flex min-w-0 flex-1 items-center">
        {!props.authenticated && (
          <div class="hidden min-w-0 items-center lg:flex">
            <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs ?? []} />
          </div>
        )}
        <div class="flex min-w-0 items-center lg:hidden">
          <span class="truncate font-semibold">{props.title}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <div class="flex items-center gap-1 lg:hidden">
          {props.authenticated && <GlobalSearchTrigger variant="header" />}
          <LayoutHelpTrigger variant="header" />
          {props.launchpad && (
            <AppLaunchpadButton
              profile={
                data.profile
                  ? { name: data.profile.name, theme: data.theme, ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}) }
                  : undefined
              }
              apps={data.apps}
              legalLinks={data.legalLinks}
              variant="header"
              label={t().openApps}
            />
          )}
        </div>
        {!props.authenticated && <LayoutPreferences initialTheme={data.theme} position="bottom-left" />}
      </div>
    </>
  );
}
