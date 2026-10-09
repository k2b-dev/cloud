import { type AuthContext, getDateConfig, getLocale, getTimeZone } from "@k2b/cloud/server";
import { notifications, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPage, AccountSubnav, notificationViews } from "./AccountHub";
import { pwaAvailable } from "./app-availability";
import BrowserNotificationSetup from "./BrowserNotificationSetup.island";
import { accountMessages } from "./messages";
import NotificationPreferences, { type NotificationAppMeta } from "./NotificationPreferences.island";
import QuietTimeSettings from "./QuietTimeSettings.island";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const [preferences, quiet] = await Promise.all([
    notifications.user.preferences.list(user.id, locale),
    notifications.user.quiet.get(user.id, getTimeZone(c)),
  ]);
  const registeredApps = getLocalizedRuntimeContext(c).apps;
  const apps: NotificationAppMeta[] = registeredApps.map((app) => ({ id: app.id, name: app.name, icon: app.icon }));

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.notifications }]}>
      <AccountHub appTab={pwaAvailable(c)} user={user} active="notifications" loginLabel={categoryPolicy.login.label}>
        <AccountPage
          title={t.notifications}
          description={t.notificationsDescription}
          actions={<AccountSubnav active="preferences" items={notificationViews(locale)} />}
        >
          <BrowserNotificationSetup />
          <QuietTimeSettings initial={quiet} dateConfig={getDateConfig(c)} />
          <NotificationPreferences initial={preferences} apps={apps} />
        </AccountPage>
      </AccountHub>
    </Layout>
  );
});
