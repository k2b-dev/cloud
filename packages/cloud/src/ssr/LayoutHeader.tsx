import { ButtonLink, IconButtonLink, useLocale } from "@k2b/ui";
import { AppLaunchpadButton } from "./app-launchpad";
import GlobalSearchTrigger from "./GlobalSearchTrigger";
import LayoutBreadcrumbs from "./LayoutBreadcrumbs";
import LayoutHelpTrigger from "./LayoutHelpTrigger";
import LayoutPreferences from "./LayoutPreferences";
import type { LayoutBreadcrumb } from "./layout-runtime";
import { platformMessages } from "./platform-messages";
import { useShellData } from "./shell-data";

type LayoutHeaderProps = {
  authenticated: boolean;
  title?: string;
  launchpad: boolean;
  breadcrumbs?: LayoutBreadcrumb[];
};

/**
 * Phones (below `md`) always get this header. From `md` it remains only on
 * anonymous pages; signed-in people reach Home, search, help, the app grid,
 * and their profile through the rail, so the app area starts at the top edge.
 * Anonymous pages have no rail: up to `lg` their header keeps the app name,
 * help, search, and the app grid, and from `lg` it shows the breadcrumbs.
 */
export default function LayoutHeader(props: LayoutHeaderProps) {
  const data = useShellData();
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  if (!data) return null;
  return (
    <header
      class={`layout-header paper flex min-h-[2.875rem] shrink-0 items-center justify-between px-2 py-1.5 md:px-3 md:py-2 ${props.authenticated ? "md:hidden" : ""}`}
      style="box-shadow: var(--ui-shadow-surface)"
    >
      <div class="flex min-w-0 items-center gap-2">
        {/* A long title must not squeeze the button; `shrink-0` sits on a wrapper because the button's own
            styles would win over a utility on the link. */}
        <div class="flex shrink-0">
          <IconButtonLink href="/" label={t().home}>
            <img src="/branding/logo" alt="" class={props.authenticated ? "h-4 w-4" : "h-6 w-6"} />
          </IconButtonLink>
        </div>
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
          <LayoutHelpTrigger variant="header" />
          {props.authenticated && <GlobalSearchTrigger variant="header" />}
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
        {!props.authenticated && (
          <>
            <LayoutPreferences initialTheme={data.theme} position="bottom-left" />
            <ButtonLink href="/auth/login" size="sm" variant="primary">
              <i class="ti ti-login" aria-hidden="true" />
              {t().signIn}
            </ButtonLink>
          </>
        )}
      </div>
    </header>
  );
}
