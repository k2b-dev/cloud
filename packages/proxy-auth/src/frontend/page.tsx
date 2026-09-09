import { NoticeCard, DataTable, type DataTableColumn, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { formatDate } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { proxyAuthService } from "../service";
import CreateProxyClient from "./_components/CreateProxyClient.island";
import ProxyClientActions from "./_components/ProxyClientActions.island";
import { proxyAuthMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = proxyAuthMessages.resolve([locale]);
  const { items: clients } = await proxyAuthService.client.list();
  const rawAppUrl = await get<string>("app.url");
  const baseUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;

  const totalAllowedGroups = clients.reduce((sum, c) => sum + c.allowedGroups.length, 0);
  const clientsWithoutGroups = clients.filter((c) => c.allowedGroups.length === 0).length;
  type ClientRow = (typeof clients)[number];
  const columns: DataTableColumn<ClientRow>[] = [
    { id: "client", header: t.client, value: (client) => client.name },
    { id: "description", header: t.description, value: (client) => client.description, cellClass: "max-w-[18rem]" },
    { id: "groups", header: t.allowedGroups, value: (client) => client.allowedGroups.length },
    { id: "created", header: t.created, value: (client) => client.createdAt, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: <span class="sr-only">{t.actions}</span>,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap",
    },
  ];

  return () => (
    <AdminLayout c={c} title={t.appName}>
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-proxy-auth-title">
          <h1 class="text-base font-semibold text-primary">{t.appName}</h1>
        </div>

        {/* Stat cards — see skills/cloud-app/references/frontend.md § Stats */}
        <StatGrid columns={3}>
          <StatCell label={t.clients} value={clients.length} sub={t.registered} accent={{ tone: "blue", icon: "ti ti-shield-half" }} />
          <StatCell label={t.allowedGroups} value={totalAllowedGroups} sub={t.acrossClients} />
          <StatCell
            label={t.noGroups}
            value={clientsWithoutGroups}
            sub={clientsWithoutGroups > 0 ? t.blockedUntilConfigured : t.allGated}
            valueClass={clientsWithoutGroups > 0 ? "text-amber-600 dark:text-amber-400" : "text-primary"}
            accent={clientsWithoutGroups > 0 ? { tone: "amber", icon: "ti ti-alert-triangle" } : { tone: "emerald", icon: "ti ti-check" }}
          />
        </StatGrid>

        <div class="flex justify-end">
          <CreateProxyClient />
        </div>

        {clients.length > 0 ? (
          <section class="paper overflow-hidden" style="view-transition-name: admin-proxy-auth-table">
            <DataTable
              rows={clients}
              columns={columns}
              getRowId={(client) => client.id}
              hoverRows
              class="overflow-x-auto"
              renderCell={({ row: client, col }) => {
                if (col.id === "client") return <span class="font-medium text-primary">{client.name}</span>;
                if (col.id === "description") {
                  return (
                    <span class="text-dimmed" title={client.description || t.noDescription}>
                      {client.description || <span class="italic">{t.noDescription}</span>}
                    </span>
                  );
                }
                if (col.id === "groups") {
                  return (
                    <div class="flex flex-wrap gap-1">
                      {client.allowedGroups.map((group) => (
                        <span class="rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400">
                          {group.name}
                        </span>
                      ))}
                    </div>
                  );
                }
                if (col.id === "created") return <span class="text-dimmed">{formatDate(client.createdAt, { locale })}</span>;
                if (col.id === "actions") return <ProxyClientActions client={client} />;
                return "";
              }}
            />
          </section>
        ) : (
          <Placeholder surface="paper" description={<>{t.empty}</>} />
        )}

        <NoticeCard tone="info" icon={false} style="view-transition-name: admin-proxy-auth-reference">
          <h2 class="mb-3 text-sm font-medium">{t.setupTitle}</h2>
          <p class="text-xs mb-3 opacity-80">{t.setupDescription}</p>

          <div class="space-y-2 text-xs font-mono mb-4">
            <div class="flex flex-col gap-0.5">
              <span class="opacity-70">{t.verifyUrlPattern}:</span>
              <code class="break-all">
                {baseUrl}/proxy-auth/verify/{"<client-id>"}
              </code>
            </div>
          </div>

          <h2 class="mb-2 mt-6 text-sm font-medium">{t.exampleConfiguration}</h2>
          <pre class="text-xs bg-blue-50 dark:bg-blue-950/30 p-3 rounded overflow-x-auto">
            {`http:
  middlewares:
    my-proxy-auth:
      forwardAuth:
        address: "${baseUrl}/proxy-auth/verify/<client-id>"
        authResponseHeaders:
          - "X-Forwarded-User"
          - "X-Forwarded-Email"
          - "X-Forwarded-Groups"
        trustForwardHeader: true`}
          </pre>

          <h2 class="mb-2 mt-6 text-sm font-medium">{t.responseHeaders}</h2>
          <div class="space-y-1 text-xs">
            <div>
              <code class="font-mono">X-Forwarded-User</code> <span class="opacity-70">— {t.username}</span>
            </div>
            <div>
              <code class="font-mono">X-Forwarded-Email</code> <span class="opacity-70">— {t.emailAddress}</span>
            </div>
            <div>
              <code class="font-mono">X-Forwarded-Groups</code> <span class="opacity-70">— {t.groupList}</span>
            </div>
          </div>
        </NoticeCard>
      </div>
    </AdminLayout>
  );
});
