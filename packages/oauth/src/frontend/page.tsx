import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { get } from "@k2b/cloud/services";
import { formatDate } from "@k2b/cloud/shared";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { DataTable, type DataTableColumn, NoticeCard, Pagination, Placeholder, StatCell, StatGrid } from "@k2b/ui";
import { ssr } from "../config";
import { oauthService } from "../service";
import ClientActions from "./_components/ClientActions.island";
import CreateClientButton from "./_components/CreateClientButton.island";
import { oauthMessages } from "./messages";

const PER_PAGE = 50;

/** Admin OAuth clients list page. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = oauthMessages.resolve([locale]);
  const search = (c.req.query("search") ?? "").trim();
  const rawPage = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const [clientsPage, summary] = await Promise.all([
    oauthService.client.list({
      pagination: { page, perPage: PER_PAGE },
      filter: { query: search || undefined },
    }),
    oauthService.client.summary(),
  ]);
  const clients = clientsPage.items;
  const totalPages = Math.ceil(clientsPage.total / clientsPage.perPage);
  const paginationBaseUrl = search ? `/admin/oauth?search=${encodeURIComponent(search)}&page=` : "/admin/oauth?page=";

  // Build base URL for OAuth endpoints
  const rawAppUrl = await get<string>("app.url");
  const baseUrl = rawAppUrl.startsWith("http") ? rawAppUrl : `https://${rawAppUrl}`;

  type ClientRow = (typeof clients)[number];
  const columns: DataTableColumn<ClientRow>[] = [
    { id: "client", header: t.client, value: (client) => client.name },
    { id: "registration", header: t.registration, value: (client) => client.registrationKind },
    { id: "description", header: t.description, value: (client) => client.description, cellClass: "max-w-[18rem]" },
    { id: "type", header: t.type, value: (client) => client.isPublic },
    { id: "access", header: t.access, value: (client) => client.accessMode },
    { id: "scopes", header: t.scopes, value: (client) => client.scopes },
    { id: "profiles", header: t.profiles, value: (client) => client.allowedProfiles },
    { id: "created", header: t.created, value: (client) => client.createdAt, cellClass: "whitespace-nowrap" },
    {
      id: "actions",
      header: <span class="sr-only">{t.actions}</span>,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap max-w-none",
    },
  ];

  return () => (
    <AdminLayout c={c} title="OAuth">
      <div class="app-rows">
        <div class="min-w-0" style="view-transition-name: admin-oauth-title">
          <h1 class="text-base font-semibold text-primary">OAuth</h1>
        </div>

        {/* Stat cards — see skills/cloud-app/references/frontend.md § Stats */}
        <StatGrid columns={3}>
          <StatCell label={t.clients} value={summary.total} sub={t.registered} accent={{ tone: "blue", icon: "ti ti-key" }} />
          <StatCell label={t.public} value={summary.public} sub={t.publicSubtitle} />
          <StatCell label={t.dynamic} value={summary.dynamic} sub={t.dynamicSubtitle} accent={{ tone: "emerald", icon: "ti ti-world" }} />
        </StatGrid>

        <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <SearchBar action="/admin/oauth" value={search} placeholder={t.searchClients} ariaLabel={t.searchClientsLabel} />
          <CreateClientButton />
        </div>

        {clients.length > 0 ? (
          <section class="paper overflow-hidden" style="view-transition-name: admin-oauth-table">
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
                if (col.id === "registration") {
                  const label =
                    client.registrationKind === "first_party"
                      ? t.firstParty
                      : client.registrationKind === "dynamic"
                        ? t.dynamic
                        : t.managed;
                  return <span class="text-dimmed">{label}</span>;
                }
                if (col.id === "type") {
                  return (
                    <span
                      class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        client.isPublic
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                          : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {client.isPublic ? t.public : t.confidential}
                    </span>
                  );
                }
                if (col.id === "scopes") {
                  return (
                    <div class="flex flex-wrap gap-1">
                      {client.scopes.map((scope) => (
                        <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-dimmed dark:bg-zinc-800">{scope}</span>
                      ))}
                    </div>
                  );
                }
                if (col.id === "access") {
                  if (client.accessMode === "specific") {
                    return (
                      <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        {t.selected({ count: client.accessUsers.length + client.accessGroups.length })}
                      </span>
                    );
                  }
                  return <span class="text-dimmed">{t.profiles}</span>;
                }
                if (col.id === "profiles") {
                  return (
                    <div class="flex flex-wrap gap-1">
                      {client.allowedProfiles.map((profile) => (
                        <span class="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
                          {profile}
                        </span>
                      ))}
                    </div>
                  );
                }
                if (col.id === "created") return <span class="text-dimmed">{formatDate(client.createdAt, { locale })}</span>;
                if (col.id === "actions") return <ClientActions client={client} />;
                return "";
              }}
            />
          </section>
        ) : (
          <Placeholder surface="paper" description={search ? <>{t.noMatch({ query: search })}</> : <>{t.noClients}</>} />
        )}

        {totalPages > 1 ? <Pagination currentPage={clientsPage.page} totalPages={totalPages} baseUrl={paginationBaseUrl} /> : null}

        <NoticeCard tone="info" style="view-transition-name: admin-oauth-reference" bodyClass="flex flex-col gap-6">
          <section>
            <h2 class="font-semibold text-primary">{t.discoveryEndpoints}</h2>
            <dl class="mt-2 flex flex-col gap-2">
              <div>
                <dt class="text-dimmed">{t.openIdConfiguration}</dt>
                <dd>
                  <a href="/.well-known/openid-configuration" class="break-all underline" target="_blank">
                    <code>{baseUrl}/.well-known/openid-configuration</code>
                  </a>
                </dd>
              </div>
              <div>
                <dt class="text-dimmed">JWKS</dt>
                <dd>
                  <a href="/.well-known/jwks.json" class="break-all underline" target="_blank">
                    <code>{baseUrl}/.well-known/jwks.json</code>
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <h2 class="font-semibold text-primary">{t.oauthEndpoints}</h2>
            <dl class="mt-2 flex flex-col gap-2">
              <div>
                <dt class="text-dimmed">{t.authorizationEndpoint}</dt>
                <dd>
                  <code class="break-all">{baseUrl}/oauth/authorize</code>
                </dd>
              </div>
              <div>
                <dt class="text-dimmed">{t.tokenEndpoint}</dt>
                <dd>
                  <code class="break-all">{baseUrl}/oauth/token</code>
                </dd>
              </div>
              <div>
                <dt class="text-dimmed">{t.dynamicRegistrationEndpoint}</dt>
                <dd>
                  <code class="break-all">{baseUrl}/oauth/register</code>
                </dd>
              </div>
              <div>
                <dt class="text-dimmed">{t.userInfoEndpoint}</dt>
                <dd>
                  <code class="break-all">{baseUrl}/oauth/userinfo</code>
                </dd>
              </div>
              <div>
                <dt class="text-dimmed">{t.logoutUrl}</dt>
                <dd>
                  <code class="break-all">{baseUrl}/oauth/logout</code>
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <h2 class="font-semibold text-primary">{t.availableScopes}</h2>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt>
                <code>openid</code>
              </dt>
              <dd class="text-dimmed">{t.requiredReturnsUserId}</dd>
              <dt>
                <code>profile</code>
              </dt>
              <dd class="text-dimmed">{t.returnsProfileClaims}</dd>
              <dt>
                <code>email</code>
              </dt>
              <dd class="text-dimmed">{t.returnsEmail}</dd>
              <dt>
                <code>groups</code>
              </dt>
              <dd class="text-dimmed">{t.returnsGroups}</dd>
            </dl>
          </section>

          <section>
            <h2 class="font-semibold text-primary">{t.claimMapping}</h2>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt class="text-dimmed">{t.idClaim}</dt>
              <dd>
                <code>sub</code> {t.or} <code>uid</code> ({t.username})
              </dd>
              <dt class="text-dimmed">{t.databaseId}</dt>
              <dd>
                <code>id</code> (UUID)
              </dd>
              <dt class="text-dimmed">{t.displayNameClaim}</dt>
              <dd>
                <code>display_name</code>
              </dd>
              <dt class="text-dimmed">{t.emailClaim}</dt>
              <dd>
                <code>email</code>
              </dd>
              <dt class="text-dimmed">{t.groupsClaim}</dt>
              <dd>
                <code>groups</code>
              </dd>
            </dl>
          </section>
        </NoticeCard>
      </div>
    </AdminLayout>
  );
});
