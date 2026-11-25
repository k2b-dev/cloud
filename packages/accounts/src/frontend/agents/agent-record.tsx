import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import { isLegacyLimitedApiKey, isModelsOnlyApiKey, type ServiceAccount } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings, serviceAccountCredentials } from "@k2b/cloud/services";
import { getServiceAccountAvatarState } from "@k2b/cloud/services/accounts/avatar";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import type { Context } from "hono";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { accountsMessages } from "../messages";
import type { AgentKeyView } from "./AgentKeyDialogs";
import AgentScreen from "./AgentScreen.island";
import { type AgentKey, agentKeyOpenFrom, agentKeySortFrom, isAgentKeyExpired, sortAgentKeys } from "./agent-keys";

/** The most keys one agent's record lists: the service's page limit. */
const KEYS_PER_PAGE = 500;

/** The service accounts the account record opens as an agent: the kinds the agent page opened, nothing more. */
export const isAgentRecordKind = (account: Pick<ServiceAccount, "kind">): boolean =>
  account.kind === "standalone" || account.kind === "agent";

const keyAccess = (credential: { scopes: readonly string[] }): AgentKey["access"] =>
  isModelsOnlyApiKey(credential) ? "models" : isLegacyLimitedApiKey(credential) ? "legacy" : "full";

/**
 * The agent kind of the account record at `/app/accounts/users/:id`: its name and picture, and its API keys in the
 * order the address names. `?key=new` opens the form for a new key, `?key=<id>` one key; both stand beside the list,
 * so reload, back and forward show the same page. The caller resolved the account and checked its kind.
 */
export const renderAgentRecord = async (c: Context<AuthContext>, account: ServiceAccount) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const sort = agentKeySortFrom(c.req.query("sort"));
  const open = agentKeyOpenFrom(c.req.query("key"));
  const [pendingRequests, picture, creator, modelsAvailable, credentials] = await Promise.all([
    accountsService.accountRequest.countPending(),
    getServiceAccountAvatarState({ id: account.id }),
    account.createdBy ? accountsService.user.get({ id: account.createdBy }) : Promise.resolve(null),
    coreSettings.get<boolean>("ai.openai_api_enabled"),
    // A failed read shows "could not be loaded" in place of the list; the head and the picture stay.
    serviceAccountCredentials
      .listOverview({
        pagination: { page: 1, perPage: KEYS_PER_PAGE },
        filter: { serviceAccountId: account.id, serviceAccountKind: account.kind, credentialStatus: "active" },
      })
      .catch(() => null),
  ]);
  const now = new Date();
  const formatted = (value: string | null) => (value ? dates.formatDateTime(value, { locale }) : null);
  const keys: AgentKeyView[] | null = credentials
    ? sortAgentKeys(
        credentials.items.map((credential) => ({
          id: credential.id,
          name: credential.name,
          tokenPrefix: credential.tokenPrefix,
          access: keyAccess(credential),
          createdAt: credential.createdAt,
          expiresAt: credential.expiresAt,
          lastUsedAt: credential.lastUsedAt,
        })),
        sort,
        locale,
      ).map((key) => ({
        id: key.id,
        name: key.name,
        tokenPrefix: key.tokenPrefix,
        access: key.access,
        created: dates.formatDateTime(key.createdAt, { locale }),
        // relative to the time of this answer, so the server and the first paint agree
        lastUsed: key.lastUsedAt ? dates.formatDateTimeRelative(key.lastUsedAt, { locale, base: now }) : null,
        lastUsedExact: formatted(key.lastUsedAt),
        expires: formatted(key.expiresAt),
        expired: isAgentKeyExpired(key, now),
      }))
    : null;

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
          created: dates.formatDateTime(account.createdAt, { locale }),
          createdBy: creator ? { name: creator.displayName || creator.uid, href: `/app/accounts/users/${creator.id}` } : null,
        }}
        keys={keys}
        keysTotal={credentials?.total ?? 0}
        sort={sort}
        open={open}
        modelsAvailable={modelsAvailable === true}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
};
