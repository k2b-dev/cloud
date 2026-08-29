import { AppWorkspace } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import { getLocale } from "../server/locale";
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
};
export default function AdminLayout({ children, c, title }: Props) {
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
    <Layout c={c} fullWidth title={breadcrumbs}>
      <AppWorkspace class="min-h-0 flex-1" resizable={false}>
        <AdminSidebar currentPath={currentPath} apps={runtime.apps} />
        <AppWorkspace.Content>
          <AppWorkspace.Main class="overflow-y-auto p-[var(--ui-space-shell)] [scrollbar-gutter:stable]">{children}</AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </Layout>
  );
}
