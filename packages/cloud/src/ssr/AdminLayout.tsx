import { AppWorkspace } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import type { PanelConsentSnapshot } from "../contracts/panel-context";
import type { RailSnapshot } from "../contracts/rail-preferences";
import { getLocale } from "../server/locale";
import type { AuthContext } from "../server/middleware/auth";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import AdminSidebar from "./AdminSidebar";
import Layout from "./Layout";
import { platformMessages } from "./platform-messages";
import { getDisplayRuntimeContext, type RuntimeContext } from "./runtime";

type Breadcrumb = { title: string; href?: string };
type AdminLayoutContext = {
  get(key: "actor"): AuthContext["Variables"]["actor"] | undefined;
  get(key: "panelConsent"): PanelConsentSnapshot | undefined;
  get(key: "railPreferences"): RailSnapshot | undefined;
  get(key: "user"): any;
  get(key: "page"): any;
  get(key: "runtime"): RuntimeContext;
  get(key: "settings"): Record<string, any>;
  get(key: "announcements"): LayoutAnnouncementsState | undefined;
  req: { raw: { headers: Headers; url: string } };
};
type Props = {
  children: JSX.Element;
  c: AdminLayoutContext;
  title: string;
  /** Disable when a bounded child such as SettingsPage owns scrolling. */
  scroll?: boolean;
};
export default function AdminLayout(props: Props) {
  // Keep children lazy so Layout installs the request locale before rendering them.
  const { c, title, scroll = true } = props;
  const locale = getLocale(c);
  const t = platformMessages.resolve([locale]).t;
  const url = new URL(c.req.raw.url);
  const currentPath = `${url.pathname}${url.search}`;
  const runtime = getDisplayRuntimeContext(c);
  // Admin is the area's root, as an app's root is: the rail and the admin sidebar lead there. So it is no level
  // above an admin page, and every admin page shows its title alone, whichever app owns it.
  const overview = title === "Overview" || title === t.overview;
  const breadcrumbs: Breadcrumb[] = [{ title: t.start, href: "/" }, { title: overview ? t.admin : title }];
  return (
    <Layout c={c} fullWidth fullPage title={breadcrumbs}>
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1" resizable={false}>
        <AdminSidebar currentPath={currentPath} apps={runtime.apps} />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={scroll} class={scroll ? "p-[var(--ui-space-shell)]" : undefined}>
            {props.children}
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
}
