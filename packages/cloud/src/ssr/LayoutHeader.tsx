import { ButtonLink } from "@k2b/ui";
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
  authenticated: boolean;
  breadcrumbs: LayoutBreadcrumb[];
  homeLabel: string;
  launchpadApps: AppLaunchpadApp[];
  legalLinks: Array<{ label: string; href: string; icon?: string }>;
  openAppsLabel: string;
  profileAvatarSrc?: string;
  profileName: string;
  searchHelpApps: GlobalSearchHelpApp[];
  signInLabel: string;
  theme: CloudTheme;
};

export default function LayoutHeader(props: LayoutHeaderProps) {
  return (
    <header
      class="layout-header paper flex min-h-[2.875rem] shrink-0 items-center justify-between px-2 py-1.5 md:px-3 md:py-2"
      style="box-shadow: var(--ui-shadow-surface)"
    >
      <div class="flex min-w-0 items-center gap-2">
        <a
          href="/"
          class={
            props.authenticated
              ? "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-zinc-100 hover:text-secondary md:hidden dark:hover:bg-zinc-800"
              : "flex shrink-0 items-center"
          }
          aria-label={props.homeLabel}
        >
          <img src="/branding/logo" alt="" class={props.authenticated ? "h-4 w-4" : "h-6 w-6"} />
        </a>
        <div class="hidden min-w-0 items-center md:flex">
          <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs} />
        </div>
        <div class="flex min-w-0 items-center md:hidden">
          <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs} mobile />
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <div class="flex items-center gap-1 md:hidden">
          <HotkeysHelpRail
            variant="header"
            registerHotkey={!props.authenticated}
            searchHelpApps={props.searchHelpApps}
            accent={props.accent}
          />
          {props.authenticated && <GlobalSearchTrigger variant="header" registerHotkey searchHelpApps={props.searchHelpApps} />}
        </div>
        {props.authenticated ? (
          <>
            <div class="md:hidden">
              <AppLaunchpad apps={props.launchpadApps} legalLinks={props.legalLinks} variant="header" label={props.openAppsLabel} />
            </div>
            <ProfilePreferences avatarSrc={props.profileAvatarSrc} initialTheme={props.theme} name={props.profileName} placement="header" />
          </>
        ) : (
          <>
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
