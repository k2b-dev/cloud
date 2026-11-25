import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import { accountsMessages } from "../messages";
import RequestsScreen from "./RequestsScreen.island";
import { parseRequestStatus, parseRequestsPage, REQUESTS_PER_PAGE } from "./requests-url";

/** Account requests on v2: the status is a view in the address (`status`, pending by default), paged with `page`. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const { t } = accountsMessages.resolve([locale]);
  const user = expectUserBackedActor(c);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const page = parseRequestsPage(c.req.query("page"));
  const status = parseRequestStatus(c.req.query("status"));

  const [pendingRequests, requestsPage] = await Promise.all([
    accountsService.accountRequest.countPending(),
    accountsService.accountRequest.list({
      access: { userId: user.id, isAdmin: true },
      pagination: { page, perPage: REQUESTS_PER_PAGE },
      filter: status === "all" ? { scope: "all" } : { status },
    }),
  ]);
  const requests = requestsPage.items.map((request) => ({
    id: request.id,
    name: request.displayName || `${request.firstName} ${request.lastName}`,
    firstName: request.firstName,
    email: request.email,
    status: request.status,
    requested: dates.formatDate(request.createdAt, { locale, timeZone }),
    comment: request.comment || null,
  }));

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: t.requests }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "requests", pendingRequests, isAdmin: true })} />
      <RequestsScreen
        status={status}
        requests={requests}
        total={requestsPage.total}
        page={requestsPage.page}
        pages={Math.max(1, Math.ceil(requestsPage.total / REQUESTS_PER_PAGE))}
        freeIpaEnabled={freeIpaEnabled}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
});
