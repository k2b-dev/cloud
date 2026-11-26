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

/** A request that waits longer than this is named in the status row. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  // what waits: the oldest pending request of this page and how many have waited longer than a week
  const now = Date.now();
  const pending = requestsPage.items.filter((request) => request.status === "pending").map((request) => Date.parse(request.createdAt));
  const oldest = pending.length > 0 ? dates.formatDate(new Date(Math.min(...pending)), { locale, timeZone }) : null;
  const overdue = pending.filter((time) => now - time > WEEK_MS).length;
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
        oldest={oldest}
        overdue={overdue}
        pendingRequests={pendingRequests}
      />
    </Layout>
  );
});
