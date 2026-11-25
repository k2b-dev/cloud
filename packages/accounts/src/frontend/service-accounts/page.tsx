import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import {
  accountsAppService as accountsService,
  coreSettings,
  STANDALONE_SERVICE_ACCOUNT_KINDS,
  serviceAccountCredentials,
} from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { listMessages } from "../list-messages";
import { accountsMessages } from "../messages";
import ApiKeysScreen from "./ApiKeysScreen.island";
import { toApiKeyRow } from "./api-key-row";
import { API_KEYS_PER_PAGE, apiKeysHref, apiKeysQuery, legacyApiKeyListHref, parseApiKeysAddress } from "./query";

/** The API keys of this Cloud on v2. The address is the whole list state: the declaration in `query.ts` reads it. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const { t } = accountsMessages.resolve([locale]);
  expectUserBackedActor(c);
  const url = new URL(c.req.url);
  // Addresses from before v2 (`search`, the standalone kind) lead to the same list in the v2 address.
  const legacy = legacyApiKeyListHref(url.searchParams);
  if (legacy) return c.redirect(legacy);

  const query = apiKeysQuery(locale);
  const address = parseApiKeysAddress(query, url.searchParams);
  const { kind, status, automatic } = address.state.filters;
  const [modelsAvailable, pendingRequests, credentialsPage] = await Promise.all([
    coreSettings.get<boolean>("ai.openai_api_enabled"),
    accountsService.accountRequest.countPending(),
    serviceAccountCredentials.listOverview({
      pagination: { page: address.page, perPage: API_KEYS_PER_PAGE },
      filter: {
        automatic: automatic === "1" ? "include" : "hide",
        search: address.state.search,
        // "Agent" covers both standalone kinds.
        serviceAccountKind: kind === "agent" ? STANDALONE_SERVICE_ACCOUNT_KINDS : kind,
        credentialStatus: status,
      },
    }),
  ]);
  const pages = Math.max(1, Math.ceil(credentialsPage.total / API_KEYS_PER_PAGE));
  // A revoked key, or an old link, can leave the requested page past the end; open the last page instead.
  if (address.page > pages) return c.redirect(apiKeysHref(query, address.state, pages));

  const now = new Date();
  const words = listMessages.resolve([locale]).t;
  const ignored =
    address.issues.length > 0
      ? words.ignoredPartsDetail({
          params: address.issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.code)).join(", "),
        })
      : null;

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.serviceAccounts }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "api-keys", pendingRequests, isAdmin: true })} />
      <ApiKeysScreen
        state={address.state}
        page={address.page}
        pages={pages}
        total={credentialsPage.total}
        rows={credentialsPage.items.map((entry) => toApiKeyRow(entry, { locale, timeZone, now }))}
        hiddenAutomatic={automatic === "1" ? null : (credentialsPage.hiddenAutomaticCount ?? 0)}
        modelsAvailable={Boolean(modelsAvailable)}
        timeZone={timeZone}
        pendingRequests={pendingRequests}
        ignored={ignored}
      />
    </Layout>
  );
});
