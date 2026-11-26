import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { formatDate, groupDisplayName } from "@k2b/cloud/shared";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { proxyAuthService } from "../service";
import ProxyAuthScreen from "./_components/ProxyAuthScreen.island";
import { proxyAuthMessages } from "./messages";

/** Proxy Auth on v2: the ForwardAuth clients, one open beside the list (`client=<id>`), and the Traefik setup. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = proxyAuthMessages.resolve([locale]);
  const { items: clients } = await proxyAuthService.client.list();
  const rawAppUrl = await get<string>("app.url");
  const baseUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
  const open = c.req.query("client")?.slice(0, 100) || null;

  return () => (
    <AdminLayout c={c} ui="v2" title={t.appName}>
      <ProxyAuthScreen
        nav={adminNavigation(c)}
        baseUrl={baseUrl}
        open={open}
        tab={c.req.query("tab") === "setup" ? "setup" : "clients"}
        figures={{
          withoutGroups: clients.filter((client) => client.allowedGroups.length === 0).length,
        }}
        clients={clients.map((client) => ({
          id: client.id,
          clientId: client.clientId,
          name: client.name,
          description: client.description,
          groups: client.allowedGroups.map((group) => ({ id: group.id, label: groupDisplayName(group.name, locale) })),
          created: formatDate(client.createdAt, { locale }),
        }))}
      />
    </AdminLayout>
  );
});
