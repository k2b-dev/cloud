import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { formatDate } from "@k2b/cloud/shared";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import type { OAuthClient } from "../contracts";
import { oauthService } from "../service";
import OAuthScreen from "./_components/OAuthScreen.island";

import { CLIENTS_PER_PAGE as PER_PAGE } from "./clients-page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * OAuth on v2: the clients (`search`, `page`), one open beside them (`client=<id>`, read on its own, so it stays open
 * on any page and with any search), and the endpoints an application needs (`tab=endpoints`).
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const search = (c.req.query("search") ?? "").trim().slice(0, 200);
  const rawPage = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const tab = c.req.query("tab") === "endpoints" ? "endpoints" : "clients";
  const openId = tab === "clients" ? c.req.query("client")?.trim() || null : null;
  const [clientsPage, summary, opened] = await Promise.all([
    oauthService.client.list({ pagination: { page, perPage: PER_PAGE }, filter: { query: search || undefined } }),
    oauthService.client.summary(),
    // an id that is no id names no client; the store is never asked for it
    openId && UUID.test(openId) ? oauthService.client.get({ id: openId }) : null,
  ]);

  // Build base URL for OAuth endpoints
  const rawAppUrl = await get<string>("app.url");
  const baseUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;
  const row = (client: OAuthClient) => ({ ...client, created: formatDate(client.createdAt, { locale }) });

  return () => (
    <AdminLayout c={c} ui="v2" title="OAuth">
      <OAuthScreen
        nav={adminNavigation(c)}
        baseUrl={baseUrl}
        tab={tab}
        search={search}
        paging={{ page: clientsPage.page, pages: Math.max(1, Math.ceil(clientsPage.total / clientsPage.perPage)) }}
        clients={clientsPage.items.map(row)}
        figures={summary}
        open={openId ? { id: openId, found: opened ? row(opened) : null } : null}
      />
    </AdminLayout>
  );
});
