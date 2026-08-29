import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { notifications } from "@valentinkolb/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountSubnav, notificationViews } from "./AccountHub";
import BrowserNotificationSetup from "./BrowserNotificationSetup.island";
import { accountMessages } from "./messages";
import NotificationPreferences, { type NotificationAppMeta } from "./NotificationPreferences.island";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const preferences = await notifications.user.preferences.list(user.id, locale);
  const registeredApps = getLocalizedRuntimeContext(c).apps;
  const apps: NotificationAppMeta[] = registeredApps.map((app) => ({ id: app.id, name: app.name, icon: app.icon }));

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.notifications }]}>
      <AccountHub user={user} active="notifications">
        <div class="flex flex-col gap-2">
          <AccountPageHeader
            title={t.notifications}
            description={t.notificationsDescription}
            actions={<AccountSubnav active="preferences" items={notificationViews(locale)} />}
          />
          <BrowserNotificationSetup />
          <NotificationPreferences initial={preferences} apps={apps} />
        </div>
      </AccountHub>
    </Layout>
  );
});
