import { ButtonLink, IconButtonLink, useLocale } from "@k2b/ui";
import CloudShell from "./CloudShell.island";
import type { LayoutBreadcrumb } from "./layout-runtime";
import { platformMessages } from "./platform-messages";

type LayoutHeaderProps = {
  authenticated: boolean;
  panelOpen?: boolean;
  title?: string;
  launchpad: boolean;
  breadcrumbs?: LayoutBreadcrumb[];
};

/**
 * Phones (below `md`) always get this header. From `md` it remains only on
 * anonymous pages; signed-in people reach Home, search, help, the app grid,
 * and their profile through the rail, so the app area starts at the top edge.
 * On a signed-in phone it is the title row on the app gradient: Home moves to
 * the bottom bar's Start, so the row holds the title, search, help, and the
 * app menu. Anonymous pages have no rail: up to `lg` their header keeps Home,
 * the app name, help, search, and the app grid, and from `lg` it shows the
 * breadcrumbs. Home and Sign in stay server markup, so focus on them survives
 * the shell's mount; the shell renders the title and the controls between them.
 */
export default function LayoutHeader(props: LayoutHeaderProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  return (
    <header
      class={`layout-header paper flex min-h-[2.875rem] shrink-0 items-center px-2 py-1.5 md:px-3 md:py-2 ${props.authenticated ? "md:hidden" : ""}`}
      style="box-shadow: var(--ui-shadow-surface)"
    >
      {/* A long title must not squeeze the button; `shrink-0` sits on a wrapper because the button's own
          styles would win over a utility on the link. */}
      {!props.authenticated && (
        <div class="flex shrink-0">
          <IconButtonLink href="/" label={t().home}>
            <img src="/branding/logo" alt="" class="h-6 w-6" />
          </IconButtonLink>
        </div>
      )}
      <CloudShell
        slot="header"
        panelOpen={props.panelOpen}
        authenticated={props.authenticated}
        title={props.title}
        launchpad={props.launchpad}
        breadcrumbs={props.breadcrumbs}
      />
      {!props.authenticated && (
        <div class="ml-1 flex shrink-0">
          <ButtonLink href="/auth/login" size="sm" variant="primary">
            <i class="ti ti-login" aria-hidden="true" />
            {t().signIn}
          </ButtonLink>
        </div>
      )}
    </header>
  );
}
