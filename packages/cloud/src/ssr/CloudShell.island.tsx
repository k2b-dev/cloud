import { useLocale } from "@k2b/ui";
import { createEffect } from "solid-js";
import { AppLaunchpadButton, setAppLaunchpadContext } from "./app-launchpad";
import GlobalSearchTrigger from "./GlobalSearchTrigger";
import LayoutBreadcrumbs from "./LayoutBreadcrumbs";
import LayoutHelpTrigger from "./LayoutHelpTrigger";
import LayoutPreferences from "./LayoutPreferences";
import type { LayoutBreadcrumb } from "./layout-runtime";
import PanelTrigger from "./PanelTrigger";
import ProfilePreferences from "./ProfilePreferences";
import { platformMessages } from "./platform-messages";
import RailApps from "./RailApps";
import { useShellData } from "./shell-data";

type CloudShellProps =
  | { slot: "rail"; currentPath: string; panelOpen?: boolean }
  | { slot: "header"; authenticated: boolean; title?: string; launchpad: boolean; breadcrumbs?: LayoutBreadcrumb[]; panelOpen?: boolean };

/**
 * The interactive part of the shell chrome. `LayoutRail` and `LayoutHeader`
 * own the frame and the plain links around it as server markup.
 */
export default function CloudShell(props: CloudShellProps) {
  return props.slot === "rail" ? (
    <RailNavigation currentPath={props.currentPath} panelOpen={props.panelOpen} />
  ) : (
    <HeaderControls {...props} />
  );
}

function RailNavigation(props: { currentPath: string; panelOpen?: boolean }) {
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (!data?.rail || !data.profile) return null;
  const profile = {
    userId: data.profile.userId,
    name: data.profile.name,
    theme: data.theme,
    ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}),
  };
  createEffect(() => setAppLaunchpadContext(data.apps, data.legalLinks, profile));
  return (
    <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label={t().apps}>
      <RailApps apps={data.apps} settings={data.rail} currentPath={props.currentPath} />
      <AppLaunchpadButton profile={profile} apps={data.apps} legalLinks={data.legalLinks} variant="rail" label={t().openApps} />
      <div class="layout-rail-actions mt-auto shrink-0 flex flex-col items-center gap-1">
        {(data.panel?.providers.length ?? 0) > 1 && <PanelTrigger open={props.panelOpen} />}
        <GlobalSearchTrigger variant="rail" />
        <LayoutHelpTrigger
          variant="rail"
          panel={data.panel?.providers.some((provider) => provider.id === "core")}
          helpOpen={!!props.panelOpen && data.panel?.provider === "core"}
        />
        <ProfilePreferences
          userId={data.profile.userId}
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
function HeaderControls(props: {
  authenticated: boolean;
  title?: string;
  launchpad: boolean;
  breadcrumbs?: LayoutBreadcrumb[];
  panelOpen?: boolean;
}) {
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (!data) return null;
  return (
    <>
      <div class="ml-2 flex min-w-0 flex-1 items-center">
        {!props.authenticated && (
          <div class="min-w-0 items-center max-lg:hidden lg:flex">
            <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs ?? []} />
          </div>
        )}
        <div class="min-w-0 items-center max-lg:flex lg:hidden">
          <span class="layout-header-title truncate font-semibold">{props.title}</span>
          {props.launchpad && (
            <AppLaunchpadButton
              profile={
                data.profile
                  ? {
                      userId: data.profile.userId,
                      name: data.profile.name,
                      theme: data.theme,
                      ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}),
                    }
                  : undefined
              }
              apps={data.apps}
              legalLinks={data.legalLinks}
              variant="title"
              label={props.title}
            />
          )}
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <div class="items-center gap-1 max-lg:flex lg:hidden">
          {props.authenticated && <GlobalSearchTrigger variant="header" />}
          <LayoutHelpTrigger
            variant="header"
            panel={data.panel?.providers.some((provider) => provider.id === "core")}
            helpOpen={!!props.panelOpen && data.panel?.provider === "core"}
          />
          {props.launchpad && (
            <AppLaunchpadButton
              profile={
                data.profile
                  ? {
                      userId: data.profile.userId,
                      name: data.profile.name,
                      theme: data.theme,
                      ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}),
                    }
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
