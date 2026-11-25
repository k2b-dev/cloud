import { accountCategoryLabel } from "@k2b/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { HTTPException } from "hono/http-exception";
import { ssr } from "../../config";
import { toAccountsActor } from "../../shared/actor";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { parseUsersListState } from "../lib/url-state";
import { accountsMessages } from "../messages";
import DuplicateEmailsScreen from "./DuplicateEmailsScreen.island";

/** Accounts that share an email address, on v2, grouped by address and paged with `page`. Times stay in UTC. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = accountsMessages.resolve([locale]);
  const actor = expectUserBackedActor(c);
  const requestedPage = parseUsersListState({ page: c.req.query("page") }).page;
  const [result, pending, policy, freeIpaEnabled] = await Promise.all([
    accountsAppService.user.listDuplicateEmails({ actor: toAccountsActor(actor), pagination: { page: requestedPage, perPage: 100 } }),
    accountsAppService.accountRequest.countPending(),
    readAccountCategoryPolicy(),
    coreSettings.get<boolean>("freeipa.enable"),
  ]);
  if (!result.ok) throw new HTTPException(403, { message: result.error.message });
  const page = result.data;
  // Deleting the last group on a page can reduce the page count.
  if (page.page !== requestedPage) return c.redirect(`/app/accounts/duplicate-emails?page=${page.page}`);
  const timestamp = (value: string | null) => (value ? dates.formatDateTime(value, { locale, timeZone: "UTC" }) : t.loginNotRecorded);
  const rows = page.items.flatMap((group) =>
    group.users.map((user) => ({
      email: group.email,
      user: {
        id: user.id,
        uid: user.uid,
        mail: user.mail,
        givenname: user.givenname,
        sn: user.sn,
        displayName: user.displayName,
        provider: user.provider,
        profile: user.profile,
      },
      name: user.displayName || user.uid,
      category: accountCategoryLabel(user, policy.login.label),
      web: timestamp(user.lastLoginLocal),
      kerberos: user.provider === "ipa" ? timestamp(user.lastLoginIpa) : "–",
      sync: user.provider === "ipa" ? timestamp(user.ipaSyncedAt) : "–",
      expires: user.accountExpires ? timestamp(user.accountExpires) : t.never,
      deletable: user.id !== actor.id && !(user.provider === "ipa" && !freeIpaEnabled),
      disabledReason: user.id === actor.id ? t.cannotDeleteSelf : undefined,
    })),
  );

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.duplicateEmails }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "duplicate-emails", pendingRequests: pending, isAdmin: true })} />
      <DuplicateEmailsScreen
        rows={rows}
        total={page.total}
        page={page.page}
        pages={Math.max(1, Math.ceil(page.total / page.perPage))}
        pendingRequests={pending}
      />
    </Layout>
  );
});
