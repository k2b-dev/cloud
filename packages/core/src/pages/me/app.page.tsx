import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { coreSettings, pwaDevices, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AppScreen from "./AppScreen.island";
import { accountUserView } from "./account-view";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";

/** `/me/app`: pair phones with the mobile app and remove them. Exists only while the app runs. */
export default ssr<AuthContext>(async (c) => {
  if (!pwaAvailable(c)) return ssr.error(c, 404);
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  c.header("Referrer-Policy", "no-referrer");
  const user = c.get("user");
  const { t } = accountMessages.resolve([getLocale(c)]);
  // Chrome on a paired Android phone shares the app's cookies: mark that phone in the list.
  const appToken = auth.session.getAppToken(c);
  const appSession = appToken ? await auth.session.authenticateRequest(c, appToken) : null;
  const currentDeviceId = appSession?.data.kind === "app" && appSession.user.id === user.id ? appSession.data.deviceId : undefined;
  const [categoryPolicy, rawAppName, devices] = await Promise.all([
    readAccountCategoryPolicy(),
    coreSettings.get<string>("app.name"),
    pwaDevices.list({ userId: user.id }, currentDeviceId),
  ]);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.pwaTab }]}>
      <AppScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        userId={user.id}
        devices={devices}
        dateConfig={getDateConfig(c)}
        description={t.pwaDescription({ cloud: rawAppName || "Cloud" })}
      />
    </Layout>
  );
});
