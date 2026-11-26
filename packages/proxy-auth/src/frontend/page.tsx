import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { matchesClientSearch } from "../client-search";
import { proxyAuthService } from "../service";
import ProxyAuthScreen from "./_components/ProxyAuthScreen.island";
import { clientRow } from "./client-row";
import { proxyAuthMessages } from "./messages";

/** Proxy Auth on v2: the ForwardAuth clients, one open beside the list (`client=<id>`), and the Traefik setup. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = proxyAuthMessages.resolve([locale]);
  const { items: all } = await proxyAuthService.client.list();
  // one read of all clients for the figures; the list shows those the service's search rule matches
  const search = (c.req.query("search") ?? "").trim().slice(0, 200);
  const clients = all.filter((client) => matchesClientSearch(client, search));
  const rawAppUrl = await get<string>("app.url");
  const baseUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
  const open = c.req.query("client")?.slice(0, 100) || null;

  return () => (
    <AdminLayout c={c} ui="v2" title={t.appName}>
      <ProxyAuthScreen
        nav={adminNavigation(c)}
        baseUrl={baseUrl}
        open={open}
        search={search}
        tab={c.req.query("tab") === "setup" ? "setup" : "clients"}
        figures={{
          withoutGroups: all.filter((client) => client.allowedGroups.length === 0).length,
          total: all.length,
        }}
        clients={clients.map((client) => clientRow(client, locale))}
      />
    </AdminLayout>
  );
});
