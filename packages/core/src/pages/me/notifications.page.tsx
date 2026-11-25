import { type AuthContext, getDateConfig, getLocale, getTimeZone } from "@k2b/cloud/server";
import { notifications, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { accountUserView } from "./account-view";
import { accountMessages } from "./messages";
import NotificationsScreen from "./NotificationsScreen.island";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const [preferences, quiet] = await Promise.all([
    notifications.user.preferences.list(user.id, locale),
    notifications.user.quiet.get(user.id, getTimeZone(c)),
  ]);
  const apps = getLocalizedRuntimeContext(c).apps.map((app) => ({ id: app.id, name: app.name, icon: app.icon }));

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.notifications }]}>
      <NotificationsScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        preferences={preferences}
        apps={apps}
        quiet={quiet}
        dateConfig={getDateConfig(c)}
      />
    </Layout>
  );
});
