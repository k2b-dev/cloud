import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, serviceAccounts } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { accountsMessages } from "../messages";
import AgentsScreen from "./AgentsScreen.island";

const parsePage = (value: string | undefined): number => {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

/** The agents of this Cloud on v2; a row opens the agent's page. */
export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  expectUserBackedActor(c);
  const page = parsePage(c.req.query("page"));
  const perPage = 100;
  const [pendingRequests, agents] = await Promise.all([
    accountsService.accountRequest.countPending(),
    serviceAccounts.listStandalone({ page, perPage }),
  ]);
  const pages = Math.max(1, Math.ceil(agents.total / perPage));
  const rows = agents.items.map((agent) => ({
    id: agent.id,
    name: agent.name,
    active: agent.status === "active",
    created: dates.formatDateTime(agent.createdAt, { locale }),
  }));

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.agents }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "agents", pendingRequests, isAdmin: true })} />
      <AgentsScreen agents={rows} total={agents.total} page={page} pages={pages} pendingRequests={pendingRequests} />
    </Layout>
  );
});
