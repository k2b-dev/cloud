import { ButtonLink, IconButtonLink } from "@k2b/ui";
import type { NavigationSearchItem } from "../browser/navigation-search";
import type { CloudThemePreference } from "../shared/theme";
import AppLaunchpad, { type AppLaunchpadApp } from "./AppLaunchpad.island";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import GlobalSearchTrigger from "./GlobalSearchTrigger.island";
import LayoutBreadcrumbs from "./LayoutBreadcrumbs.island";
import LayoutHelpTrigger from "./LayoutHelpTrigger.island";
import LayoutPreferences from "./LayoutPreferences.island";
import type { LayoutBreadcrumb } from "./layout-runtime";

type LayoutHeaderProps = {
  accent?: string;
  /** Set while the installation offers the mobile app. */
  appHref?: string;
  appLabel?: string;
  authenticated: boolean;
  breadcrumbs: LayoutBreadcrumb[];
  homeLabel: string;
  launchpadApps: AppLaunchpadApp[];
  legalLinks: Array<{ label: string; href: string; icon?: string }>;
  openAppsLabel: string;
  profileName: string;
  searchHelpApps: GlobalSearchHelpApp[];
  searchLinks?: NavigationSearchItem[];
  signInLabel: string;
  theme: CloudThemePreference;
};

/**
 * Phones (below `md`) always get this header. From `md` it remains only on
 * anonymous pages; signed-in people reach Home, search, help, the app grid,
 * and their profile through the rail, so the app area starts at the top edge.
 * Anonymous pages have no rail: up to `lg` their header keeps the app name,
 * help, search, and the app grid, and from `lg` it shows the breadcrumbs.
 */
export default function LayoutHeader(props: LayoutHeaderProps) {
  return (
    <header
      class={`layout-header paper flex min-h-[2.875rem] shrink-0 items-center justify-between px-2 py-1.5 md:px-3 md:py-2 ${props.authenticated ? "md:hidden" : ""}`}
      style="box-shadow: var(--ui-shadow-surface)"
    >
      <div class="flex min-w-0 items-center gap-2">
        {/* A long title must not squeeze the button; `shrink-0` sits on a wrapper because the button's own
            styles would win over a utility on the link. */}
        <div class="flex shrink-0">
          <IconButtonLink href="/" label={props.homeLabel}>
            <img src="/branding/logo" alt="" class={props.authenticated ? "h-4 w-4" : "h-6 w-6"} />
          </IconButtonLink>
        </div>
        {!props.authenticated && (
          <div class="hidden min-w-0 items-center lg:flex">
            <LayoutBreadcrumbs breadcrumbs={props.breadcrumbs} />
          </div>
        )}
        <div class="flex min-w-0 items-center lg:hidden">
          <span class="truncate font-semibold">{props.appLabel ?? props.breadcrumbs.at(-1)?.title}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <div class="flex items-center gap-1 lg:hidden">
          <LayoutHelpTrigger
            variant="header"
            registerCommand={!props.authenticated}
            searchHelpApps={props.searchHelpApps}
            accent={props.accent}
          />
          <GlobalSearchTrigger
            variant={props.authenticated ? "header" : "host"}
            registerCommand
            searchLinks={props.searchLinks}
            searchResources={props.authenticated}
          />
          {(props.authenticated || props.appLabel) && (
            <AppLaunchpad
              profile={
                props.authenticated
                  ? { name: props.profileName, theme: props.theme, ...(props.appHref ? { appHref: props.appHref } : {}) }
                  : undefined
              }
              apps={props.launchpadApps}
              legalLinks={props.legalLinks}
              variant="header"
              label={props.openAppsLabel}
            />
          )}
        </div>
        {!props.authenticated && (
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
