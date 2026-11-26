import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { isAgentServiceAccountKind, type ServiceAccount } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@k2b/cloud/services";
import { getServiceAccountAvatarState } from "@k2b/cloud/services/accounts/avatar";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import type { Context } from "hono";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { accountsMessages } from "../messages";
import { firstKeyPage } from "../service-accounts/account-keys.server";
import { firstDirectoryPage } from "../service-accounts/directory-access.server";
import AgentScreen from "./AgentScreen.island";

/** The service accounts the account record opens as an agent: the kinds the agent page opened, nothing more. */
export const isAgentRecordKind = (account: Pick<ServiceAccount, "kind">): boolean => isAgentServiceAccountKind(account.kind);

/**
 * The agent kind of the account record at `/app/accounts/users/:id`: its name, picture and state, the first page of its
 * API keys and of its directory access (both through the services their sections page with), and who created it.
 * The caller resolved the account and checked its kind.
 */
export const renderAgentRecord = async <E extends AuthContext>(c: Context<E>, account: ServiceAccount) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const timeZone = getTimeZone(c);
  const actor = expectUserBackedActor(c);
  const now = new Date();
  const [pendingRequests, picture, creator, modelsAvailable, keys, directory] = await Promise.all([
    accountsService.accountRequest.countPending(),
    getServiceAccountAvatarState({ id: account.id }),
    account.createdBy ? accountsService.user.get({ id: account.createdBy }) : Promise.resolve(null),
    coreSettings.get<boolean>("ai.openai_api_enabled"),
    // A failed read shows "could not be loaded" in the section; the head and the picture stay.
    firstKeyPage({ kind: "agent", id: account.id }, { locale, timeZone, now }),
    firstDirectoryPage(actor, account.id),
  ]);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.users, href: "/app/accounts/users" },
        { title: account.name },
      ]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "agents", pendingRequests, isAdmin: true })} />
      <AgentScreen
        agent={{
          id: account.id,
          name: account.name,
          active: account.status === "active",
          image: cloudAvatarImage({ kind: "service_account", userId: account.id, avatarHash: picture?.avatarHash }),
          created: dates.formatDateTime(account.createdAt, { locale, timeZone }),
          createdBy: creator ? { name: creator.displayName || creator.uid, href: `/app/accounts/users/${creator.id}` } : null,
        }}
        keys={keys}
        directory={directory}
        modelsAvailable={modelsAvailable === true}
        timeZone={timeZone}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
};
