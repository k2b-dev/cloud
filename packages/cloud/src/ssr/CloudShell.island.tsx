import { TabBar, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { isServer, Portal } from "solid-js/web";
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
import { RAIL_PREFERENCES_EVENT, readRailContext } from "./rail-context";
import { phoneBarItems, projectRailNavigation } from "./rail-navigation";
import ShellFocusToggle from "./ShellFocusToggle";
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

/**
 * The phone bar's live copy, mounted with the rail's island so the shell adds no island instance. It renders nothing
 * while the server's bar is current, so mounting moves and refocuses nothing. When the saved rail preferences or the
 * URL (a fragment, Back and Forward, an in-page navigation) change what the bar shows, it renders the new bar into the
 * bar's row, and CSS hides the server's.
 */
function BarNavigation(props: { currentPath: string }) {
  if (isServer) return null;
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const initial = data?.rail;
  if (!data || !initial) return null;
  const [settings, setSettings] = createSignal(initial);
  const [currentPath, setCurrentPath] = createSignal(props.currentPath);
  const itemsFor = (rail: typeof initial, path: string) =>
    phoneBarItems(projectRailNavigation(data.apps, rail, locale()), path, { label: t().home, path: data.home ?? "/" });
  const served = JSON.stringify(itemsFor(initial, props.currentPath));
  const items = createMemo(() => itemsFor(settings(), currentPath()));
  onMount(() => {
    const sync = () => setSettings(readRailContext()?.settings ?? initial);
    const syncLocation = () => setCurrentPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
    syncLocation();
    window.addEventListener(RAIL_PREFERENCES_EVENT, sync);
    window.addEventListener("popstate", syncLocation);
    window.addEventListener("ssr:nav-popstate", syncLocation);
    window.addEventListener("ssr:nav-swapped", sync);
    window.addEventListener("ssr:nav-swapped", syncLocation);
    window.addEventListener("hashchange", syncLocation);
    // In-page navigation (`@k2b/ssr/nav`) commits with pushState or replaceState, which only the Navigation API
    // reports; where a browser lacks it, the bar follows at the next page load.
    window.navigation?.addEventListener("currententrychange", syncLocation);
    onCleanup(() => {
      window.removeEventListener(RAIL_PREFERENCES_EVENT, sync);
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener("ssr:nav-popstate", syncLocation);
      window.removeEventListener("ssr:nav-swapped", sync);
      window.removeEventListener("ssr:nav-swapped", syncLocation);
      window.removeEventListener("hashchange", syncLocation);
      window.navigation?.removeEventListener("currententrychange", syncLocation);
    });
  });
  const row = document.querySelector<HTMLElement>(".cloud-tab-bar__row");
  if (!row) return null;
  return (
    <Show when={JSON.stringify(items()) !== served}>
      <Portal mount={row}>
        <TabBar variant="floating" class="cloud-tab-bar__live" label={t().apps} items={items()} />
      </Portal>
    </Show>
  );
}

function RailNavigation(props: { currentPath: string; panelOpen?: boolean }) {
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
      <BarNavigation currentPath={props.currentPath} />
      <div class="mt-auto shrink-0 flex flex-col items-center gap-1">
        {(data.panel?.providers.length ?? 0) > 1 && <PanelTrigger variant="rail" open={props.panelOpen} />}
        <GlobalSearchTrigger variant="rail" />
        <LayoutHelpTrigger
          variant="rail"
          panel={data.panel?.providers.some((provider) => provider.id === "core")}
          helpOpen={!!props.panelOpen && data.panel?.provider === "core"}
        />
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
          <div class="hidden min-w-0 items-center lg:flex">
            <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs ?? []} />
          </div>
        )}
        <div class="flex min-w-0 items-center lg:hidden">
          <span class="layout-header-title truncate font-semibold">{props.title}</span>
          {props.launchpad && (
            <AppLaunchpadButton
              profile={
                data.profile
                  ? { name: data.profile.name, theme: data.theme, ...(data.profile.appHref ? { appHref: data.profile.appHref } : {}) }
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
        <div class="flex items-center gap-1 lg:hidden">
          {(data.panel?.providers.length ?? 0) > 1 && <PanelTrigger variant="header" open={props.panelOpen} />}
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
