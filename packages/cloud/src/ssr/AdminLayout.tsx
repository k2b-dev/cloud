import { AppWorkspace } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { getLocale } from "../server/locale";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import AdminSidebar from "./AdminSidebar";
import Layout from "./Layout";
import { platformMessages } from "./platform-messages";
import { getLocalizedRuntimeContext, type RuntimeContext } from "./runtime";

type Breadcrumb = { title: string; href?: string };
type AdminLayoutContext = {
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
export default function AdminLayout({ children, c, title, scroll = true }: Props) {
  const locale = getLocale(c);
  const t = platformMessages.resolve([locale]).t;
  const url = new URL(c.req.raw.url);
  const currentPath = `${url.pathname}${url.search}`;
  const runtime = getLocalizedRuntimeContext(c);
  const breadcrumbs: Breadcrumb[] = [
    { title: t.start, href: "/" },
    { title: t.admin, href: "/admin" },
  ];
  if (title !== "Overview" && title !== t.overview) {
    breadcrumbs.push({ title });
  }
  return (
    <Layout c={c} fullWidth fullPage title={breadcrumbs}>
      <AppWorkspace class="min-h-0 flex-1" resizable={false}>
        <AdminSidebar currentPath={currentPath} apps={runtime.apps} />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={scroll} class={scroll ? "p-[var(--ui-space-shell)]" : undefined}>
            {children}
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
}
