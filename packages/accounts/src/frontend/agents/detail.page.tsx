import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, isStandaloneServiceAccountKind, serviceAccounts } from "@k2b/cloud/services";
import { getServiceAccountAvatarState } from "@k2b/cloud/services/accounts/avatar";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { StatusBadge, Tag } from "@k2b/ui";
import { ssr } from "../../config";
import AccountsFactGrid from "../AccountsFactGrid";
import AccountsWorkspace from "../AccountsWorkspace";
import { accountsMessages } from "../messages";
import AgentPictureTrigger from "./AgentPictureTrigger.island";
import { agentIdFromPath } from "./agent-id";

/** One agent or standalone service account: its picture, which opens "Change profile picture", and its facts. */
export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const id = agentIdFromPath(c.req.param("id"));
  const account = id ? await serviceAccounts.get({ id }) : null;
  if (!account || !isStandaloneServiceAccountKind(account.kind)) return c.notFound();
  const [pendingRequestsPage, picture, creator] = await Promise.all([
    accountsService.accountRequest.list({ access: { userId: user.id, isAdmin: true }, filter: { status: "pending" } }),
    getServiceAccountAvatarState({ id: account.id }),
    account.createdBy ? accountsService.user.get({ id: account.createdBy }) : Promise.resolve(null),
  ]);
  const kindLabel = account.kind === "agent" ? t.agent : t.standalone;
  const facts = [
    { label: t.type, value: kindLabel },
    {
      label: t.status,
      value: (
        <StatusBadge tone={account.status === "active" ? "ok" : "error"} label={account.status === "active" ? t.active : t.agentDisabled} />
      ),
    },
    { label: t.created, value: dates.formatDateTime(account.createdAt, { locale }) },
    {
      label: t.agentCreatedBy,
      value: creator ? (
        <a href={`/app/accounts/users/${creator.id}`} class="text-primary hover:underline">
          {creator.displayName || creator.uid}
        </a>
      ) : (
        "-"
      ),
    },
  ];

  return () => (
    <Layout
      c={c}
      fullWidth
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.agents, href: "/app/accounts/agents" },
        { title: account.name },
      ]}
    >
      <AccountsWorkspace
        active="agents"
        ancestor
        isAdmin
        pendingRequests={pendingRequestsPage.total}
        scrollPreserveKey="accounts-agent-detail"
      >
        <div class="flex flex-col gap-3">
          <div class="flex min-w-0 items-center gap-4 py-2" style="view-transition-name: accounts-agent-title">
            <AgentPictureTrigger id={account.id} name={account.name} avatarHash={picture?.avatarHash ?? null} />
            <div class="min-w-0 flex-1">
              <h1 class="truncate text-xl font-semibold tracking-tight text-primary">{account.name}</h1>
              <p class="mt-1 truncate text-xs text-dimmed">{t.agentGeneralDescription}</p>
              <div class="mt-2">
                <Tag>{kindLabel}</Tag>
              </div>
            </div>
          </div>
          <AccountsFactGrid facts={facts} viewTransitionName="accounts-agent-facts" />
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
