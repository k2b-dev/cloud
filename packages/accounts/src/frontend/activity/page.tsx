import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale, getTimeZone } from "@k2b/cloud/server";
import { accountsAppService as accountsService } from "@k2b/cloud/services";
import { isAdminUser } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
import { ssr } from "../../config";
import AccountsNavigation from "../AccountsNavigation.island";
import { accountsNavigationItems } from "../accounts-nav";
import AuditScreen from "../audit/AuditScreen.island";
import { loadAudit } from "../audit/load";
import DeletedAccountsScreen from "../deleted-accounts/DeletedAccountsScreen.island";
import { loadDeleted } from "../deleted-accounts/load";
import { accountsMessages } from "../messages";
import { loadNotifications } from "../notifications/load";
import NotificationsScreen from "../notifications/NotificationsScreen.island";
import { loadReminders } from "../reminders/load";
import RemindersScreen from "../reminders/RemindersScreen.island";
import { activityKindOf } from "./kind";
import { activityMessages } from "./messages";

/**
 * The activity of Accounts on v2: the audit log, the notification batches, the reminders and the deleted accounts as one
 * list whose kind is a required filter (`kind`, the audit log by default). Each kind has its own filters and columns and
 * reads its entries through the same service as its former page; only administrators see any of them.
 */
export default ssr<AuthContext>(async (c) => {
  // every kind was for administrators only; the route says so too, the page does not rely on it
  if (!isAdminUser(expectUserBackedActor(c))) return ssr.error(c, 403);
  const locale = getLocale(c);
  const timeZone = getTimeZone(c);
  const url = new URL(c.req.url);
  const kind = activityKindOf(url.searchParams);
  const pendingRequests = await accountsService.accountRequest.countPending();
  const context = { locale, timeZone, pendingRequests };
  // each kind loads through its own service; a kind's loader may send the address elsewhere (a page past the end)
  let screen: () => JSX.Element;
  if (kind === "audit") {
    const loaded = await loadAudit(url, context);
    if ("redirect" in loaded) return c.redirect(loaded.redirect);
    screen = () => <AuditScreen {...loaded.props} />;
  } else if (kind === "notifications") {
    const loaded = await loadNotifications(url, context);
    if ("redirect" in loaded) return c.redirect(loaded.redirect);
    screen = () => <NotificationsScreen {...loaded.props} />;
  } else if (kind === "reminders") {
    const loaded = await loadReminders(url, context);
    if ("redirect" in loaded) return c.redirect(loaded.redirect);
    screen = () => <RemindersScreen {...loaded.props} />;
  } else {
    const loaded = await loadDeleted(url, context);
    if ("redirect" in loaded) return c.redirect(loaded.redirect);
    screen = () => <DeletedAccountsScreen {...loaded.props} />;
  }

  const { t } = accountsMessages.resolve([locale]);
  const words = activityMessages.resolve([locale]).t;
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.accounts, href: "/app/accounts" }, { title: words.activity }]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "activity", pendingRequests, isAdmin: true })} />
      {screen()}
    </Layout>
  );
});
