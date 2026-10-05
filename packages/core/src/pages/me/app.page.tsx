import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { coreSettings, pwaDevices, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPage } from "./AccountHub";
import AppDevices from "./AppDevices.island";
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
  const cloud = rawAppName || "Cloud";

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.pwaTab }]}>
      <AccountHub appTab user={user} active="app" loginLabel={categoryPolicy.login.label}>
        <AccountPage title={t.pwaTab} description={t.pwaDescription({ cloud })}>
          <AppDevices userId={user.id} initial={devices} dateConfig={getDateConfig(c)} />
        </AccountPage>
      </AccountHub>
    </Layout>
  );
});
