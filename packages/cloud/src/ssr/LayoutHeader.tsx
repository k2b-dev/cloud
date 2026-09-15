import { ButtonLink } from "@k2b/ui";
import type { NavigationSearchItem } from "../browser/navigation-search";
import type { CloudTheme } from "../shared/theme";
import AppLaunchpad, { type AppLaunchpadApp } from "./AppLaunchpad.island";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import GlobalSearchTrigger from "./GlobalSearchTrigger.island";
import HotkeysHelpRail from "./HotkeysHelpRail.island";
import LayoutBreadcrumbs from "./LayoutBreadcrumbs.island";
import type { LayoutBreadcrumb } from "./layout-runtime";
import LayoutPreferences from "./LayoutPreferences.island";
import ProfilePreferences from "./ProfilePreferences.island";

type LayoutHeaderProps = {
  accent?: string;
  appLabel?: string;
  authenticated: boolean;
  breadcrumbs: LayoutBreadcrumb[];
  homeLabel: string;
  launchpadApps: AppLaunchpadApp[];
  legalLinks: Array<{ label: string; href: string; icon?: string }>;
  openAppsLabel: string;
  profileAvatarSrc?: string;
  profileName: string;
  searchHelpApps: GlobalSearchHelpApp[];
  searchLinks?: NavigationSearchItem[];
  signInLabel: string;
  theme: CloudTheme;
};

export default function LayoutHeader(props: LayoutHeaderProps) {
  return (
    <header
      class="layout-header paper flex min-h-[2.875rem] shrink-0 items-center justify-between px-2 py-1.5 lg:px-3 lg:py-2"
      style="box-shadow: var(--ui-shadow-surface)"
    >
      <div class="flex min-w-0 items-center gap-2">
        <a
          href="/"
          class={
            props.authenticated
              ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-zinc-100 hover:text-secondary lg:hidden dark:hover:bg-zinc-800"
              : "flex shrink-0 items-center"
          }
          aria-label={props.homeLabel}
        >
          <img src="/branding/logo" alt="" class={props.authenticated ? "h-4 w-4" : "h-6 w-6"} />
        </a>
        <div class="hidden min-w-0 items-center lg:flex">
          <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs} />
        </div>
        <div class="flex min-w-0 items-center lg:hidden">
          <span class="truncate font-semibold">{props.appLabel ?? props.breadcrumbs.at(-1)?.title}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <div class="flex items-center gap-1 lg:hidden">
          <HotkeysHelpRail
            variant="header"
            registerHotkey={!props.authenticated}
            searchHelpApps={props.searchHelpApps}
            accent={props.accent}
          />
          {props.authenticated && <GlobalSearchTrigger variant="header" registerHotkey searchLinks={props.searchLinks} searchHelpApps={props.searchHelpApps} />}
        </div>
        {props.authenticated ? (
          <>
            <div class="lg:hidden">
              <AppLaunchpad
                profile={props.authenticated ? { name: props.profileName, theme: props.theme } : undefined}
                apps={props.launchpadApps}
                legalLinks={props.legalLinks}
                variant="header"
                label={props.openAppsLabel}
              />
            </div>
            <div class="hidden lg:block">
              <ProfilePreferences
                avatarSrc={props.profileAvatarSrc}
                initialTheme={props.theme}
                name={props.profileName}
                placement="header"
              />
            </div>
          </>
        ) : (
          <>
            {props.appLabel && (
              <div class="lg:hidden">
                <AppLaunchpad
                  profile={props.authenticated ? { name: props.profileName, theme: props.theme } : undefined}
                  apps={props.launchpadApps}
                  legalLinks={props.legalLinks}
                  variant="header"
                  label={props.openAppsLabel}
                />
              </div>
            )}
            <LayoutPreferences initialTheme={props.theme} position="bottom-left" />
            <ButtonLink href="/auth/login" size="sm" variant="primary">
              <i class="ti ti-login" aria-hidden="true" />
              {props.signInLabel}
            </ButtonLink>
          </>
        )}
      </div>
    </header>
  );
}
