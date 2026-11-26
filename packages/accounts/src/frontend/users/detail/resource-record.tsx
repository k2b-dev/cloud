import type { ServiceAccount } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import type { Context } from "hono";
import AccountsNavigation from "../../AccountsNavigation.island";
import { accountsNavigationItems } from "../../accounts-nav";
import { accountsMessages } from "../../messages";
import { firstKeyPage } from "../../service-accounts/account-keys.server";
import ResourceScreen from "./ResourceScreen.island";

/** The service accounts the record opens as an app's API key account. */
export const isResourceRecordKind = (account: Pick<ServiceAccount, "kind">): boolean => account.kind === "resource_bound";

/**
 * The API key kind of the account record at `/app/accounts/users/:id`: the account of an app's resource and its keys,
 * the first page read through the service the key section pages with. The caller resolved the account (the same
 * permission-aware read as for an agent, on the administrators' route) and checked its kind.
 */
export const renderResourceRecord = async <E extends AuthContext>(c: Context<E>, account: ServiceAccount) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const timeZone = getTimeZone(c);
  const [pendingRequests, modelsAvailable, keys] = await Promise.all([
    accountsService.accountRequest.countPending(),
    coreSettings.get<boolean>("ai.openai_api_enabled"),
    firstKeyPage({ kind: "resource", id: account.id }, { locale, timeZone, now: new Date() }, c.req.query("key")),
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
      <AccountsNavigation items={accountsNavigationItems(t, { active: "users", pendingRequests, isAdmin: true })} />
      <ResourceScreen
        account={{
          id: account.id,
          name: account.name,
          active: account.status === "active",
          appId: account.appId,
          resourceType: account.resourceType,
          resourceId: account.resourceId,
        }}
        keys={keys}
        modelsAvailable={modelsAvailable === true}
        timeZone={timeZone}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
};
