import { CloudAvatar } from "@k2b/cloud/account/ui";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, serviceAccounts } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Paper, Placeholder, StatusBadge } from "@k2b/ui";
import { ssr } from "../../config";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

type Agent = Awaited<ReturnType<typeof serviceAccounts.listStandalone>>["items"][number];

/** Agents and standalone service accounts, each with its picture; a row opens the agent's page. */
export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const page = parsePage(c.req.query("page"));
  const perPage = 100;
  const [pendingRequestsPage, agents] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    serviceAccounts.listStandalone({ page, perPage }),
  ]);
  const totalPages = Math.max(1, Math.ceil(agents.total / perPage));
  const columns: DataTableColumn<Agent>[] = [
    { id: "name", header: t.name, value: (agent) => agent.name, cellClass: "min-w-[14rem]" },
    { id: "kind", header: t.type, value: (agent) => agent.kind },
    { id: "status", header: t.status, value: (agent) => agent.status },
    { id: "created", header: t.created, value: (agent) => agent.createdAt, cellClass: "whitespace-nowrap" },
  ];

  return () => (
    <Layout c={c} fullWidth title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.agents }]}>
      <AccountsWorkspace active="agents" isAdmin pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-agents">
        <div class="flex flex-col gap-2">
          <div class="min-w-0" style="view-transition-name: accounts-agents-title">
            <h1 class="text-base font-semibold text-primary">{t.agents}</h1>
            <p class="mt-1 text-xs text-dimmed">{t.agentsSummary({ count: agents.total })}</p>
          </div>
          {agents.items.length === 0 ? (
            <Placeholder surface="paper" description={<>{t.noAgents}</>} />
          ) : (
            <Paper class="overflow-hidden" style="view-transition-name: accounts-agents-table">
              <DataTable
                rows={agents.items}
                columns={columns}
                getRowId={(agent) => agent.id}
                hoverRows
                highlightColumns={false}
                class="overflow-x-auto"
                scrollPreserveKey="accounts-agents-table"
                renderCell={({ row: agent, col }) => {
                  if (col.id === "name")
                    return (
                      <a
                        href={`/app/accounts/agents/${agent.id}`}
                        class="flex min-h-8 min-w-0 items-center gap-2 font-medium text-primary hover:underline"
                      >
                        <CloudAvatar username={agent.name} userId={agent.id} kind="service_account" size="xs" />
                        <span class="truncate">{agent.name}</span>
                      </a>
                    );
                  if (col.id === "kind") return <span class="text-dimmed">{agent.kind === "agent" ? t.agent : t.standalone}</span>;
                  if (col.id === "status")
                    return (
                      <StatusBadge
                        tone={agent.status === "active" ? "ok" : "error"}
                        label={agent.status === "active" ? t.active : t.agentDisabled}
                      />
                    );
                  if (col.id === "created") return <span class="text-dimmed">{dates.formatDateTime(agent.createdAt, { locale })}</span>;
                  return "";
                }}
              />
            </Paper>
          )}
          <div class="pt-1">
            <Pagination currentPage={page} totalPages={totalPages} baseUrl="/app/accounts/agents?page=" />
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
