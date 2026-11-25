import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, readAccountCategoryPolicy, webauthn } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { approvalAvailability } from "../app-approval/availability";
import { accountUserView } from "./account-view";
import { ACTIVITY_PAGE_PATH } from "./activity-query";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";
import SecurityScreen from "./SecurityScreen.island";

export default ssr<AuthContext>(async (c) => {
  // The activity has its own view since v2; an old link with its range opens it with every parameter.
  const url = new URL(c.req.url);
  if (url.searchParams.has("activityDays")) return c.redirect(`${ACTIVITY_PAGE_PATH}${url.search}`, 302);
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const { t } = accountMessages.resolve([getLocale(c)]);
  const isAdmin = user.roles.includes("admin");
  const token = auth.session.getToken(c);
  const session = token ? await auth.session.authenticateRequest(c, token) : null;
  const [approvalConfig, devices] = await Promise.all([
    appApproval.config(false).catch(() => null),
    session
      ? appApproval.listDevices({ userId: session.user.id, sid: session.data.sid, admin: isAdmin }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const availability = approvalAvailability(approvalConfig);
  const [freeIpaEnabledRaw, passkeys] = await Promise.all([
    coreSettings.get<boolean>("freeipa.enable"),
    webauthn.listForUser({ userId: user.id }),
  ]);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.security }]}>
      <SecurityScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        appTab={pwaAvailable(c)}
        userId={user.id}
        provider={user.provider}
        profile={user.profile}
        freeIpaEnabled={Boolean(freeIpaEnabledRaw)}
        passkeys={passkeys}
        devices={
          isAdmin || availability === "configured"
            ? {
                initial: devices,
                availability,
                admin: isAdmin,
                pairing:
                  approvalConfig?.enabled && approvalConfig.appOrigin
                    ? { userId: user.id, name: `${user.displayName || user.uid} (${user.uid})`, appOrigin: approvalConfig.appOrigin }
                    : undefined,
              }
            : null
        }
        now={new Date().toISOString()}
      />
    </Layout>
  );
});
