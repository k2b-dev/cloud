import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import AccountsNavigation from "../../AccountsNavigation.island";
import { accountsNavigationItems } from "../../accounts-nav";
import { accountsMessages } from "../../messages";
import type { AccountRequestView } from "./create-user";
import NewUserScreen from "./NewUserScreen.island";

/** A new account on v2. `?request=<id>` fills the form from an open account request, which the page can also deny. */
export default ssr<AuthContext>(async (c) => {
  const { t } = accountsMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const requestId = c.req.query("request");
  const [freeIpaEnabled, localEmailOptional, categoryPolicy, pendingRequests, requestResult] = await Promise.all([
    coreSettings.get<boolean>("freeipa.enable").then(Boolean),
    coreSettings.get<boolean>("user.local_email_optional").then(Boolean),
    readAccountCategoryPolicy(),
    accountsService.accountRequest.countPending(),
    requestId ? accountsService.accountRequest.get({ id: requestId, access: { userId: user.id, isAdmin: true } }) : null,
  ]);
  // Only an open request fills the form; a completed, denied or unknown one leaves an empty form.
  const request: AccountRequestView | null =
    requestResult?.ok && requestResult.data.status === "pending"
      ? {
          id: requestResult.data.id,
          email: requestResult.data.email,
          firstName: requestResult.data.firstName,
          lastName: requestResult.data.lastName,
          displayName: requestResult.data.displayName,
          phone: requestResult.data.phone,
          comment: requestResult.data.comment,
        }
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
        { title: t.newUser },
      ]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "users", pendingRequests, isAdmin: true })} />
      <NewUserScreen
        categoryPolicy={categoryPolicy}
        freeIpaEnabled={freeIpaEnabled}
        localEmailOptional={localEmailOptional}
        request={request}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
});
