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
import {
  AGENT_KEYS_PER_PAGE,
  type AgentKey,
  agentKeyOpenFrom,
  agentKeyPageFrom,
  agentKeySortFrom,
  agentPageHref,
  isAgentKeyExpired,
  sortAgentKeys,
} from "./agent-keys";

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
export const renderAgentRecord = async <E extends AuthContext>(c: Context<E>, account: ServiceAccount) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const requestedSort = agentKeySortFrom(c.req.query("sort"));
  const open = agentKeyOpenFrom(c.req.query("key"));
  const page = agentKeyPageFrom(c.req.query("page"));
  const [pendingRequests, picture, creator, modelsAvailable, credentials] = await Promise.all([
    accountsService.accountRequest.countPending(),
    getServiceAccountAvatarState({ id: account.id }),
    account.createdBy ? accountsService.user.get({ id: account.createdBy }) : Promise.resolve(null),
    coreSettings.get<boolean>("ai.openai_api_enabled"),
    // A failed read shows "could not be loaded" in place of the list; the head and the picture stay.
    serviceAccountCredentials
      .listOverview({
        pagination: { page, perPage: AGENT_KEYS_PER_PAGE },
        filter: { serviceAccountId: account.id, serviceAccountKind: account.kind, credentialStatus: "active" },
      })
      .catch(() => null),
  ]);
  const pages = Math.max(1, Math.ceil((credentials?.total ?? 0) / AGENT_KEYS_PER_PAGE));
  // a page past the end (keys were revoked meanwhile) opens the last one, with the same order and open key
  if (credentials && page > pages)
    return c.redirect(
      agentPageHref(account.id, {
        sort: requestedSort,
        page: pages,
        open: open.kind === "new" ? "new" : open.kind === "key" ? open.id : undefined,
      }),
      302,
    );
  // the service pages the newest first; a column order holds only while every key stands on the one page
  const sortable = pages === 1;
  const sort = sortable ? requestedSort : "created";
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
        page={page}
        pages={pages}
        sortable={sortable}
        sort={sort}
        open={open}
        modelsAvailable={modelsAvailable === true}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
};
