import { cloudMcpResourceUri, publicCloudOrigin } from "@k2b/cloud/api";
import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { appApproval, coreSettings, pwaDevices, readAccountCategoryPolicy, serviceAccountCredentials, webauthn } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { approvalAvailability } from "../app-approval/availability";
import { accountUserView } from "./account-view";
import { activityHref } from "./activity-query";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";
import SecurityScreen from "./SecurityScreen.island";

/**
 * `/me/security`: the account's "Security & devices". It took in the API keys of `/me/developer` and the phones of
 * `/me/app`; the sign-in activity is a kind of `/me/activity`.
 */
export default ssr<AuthContext>(async (c) => {
  // An old link with the activity's range opens the activity with every parameter.
  const url = new URL(c.req.url);
  if (url.searchParams.has("activityDays")) return c.redirect(activityHref("sign-ins", url.searchParams), 302);
  // The page shows pairing links of the mobile app: it is never framed and sends no referrer, as /me/app did.
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
  c.header("Referrer-Policy", "no-referrer");
  const user = c.get("user");
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const isAdmin = user.roles.includes("admin");
  const token = auth.session.getToken(c);
  const session = token ? await auth.session.authenticateRequest(c, token) : null;
  const phonesAvailable = pwaAvailable(c);
  // Chrome on a paired Android phone shares the app's cookies: mark that phone in the list.
  const appToken = phonesAvailable ? auth.session.getAppToken(c) : undefined;
  const appSession = appToken ? await auth.session.authenticateRequest(c, appToken) : null;
  const currentDeviceId = appSession?.data.kind === "app" && appSession.user.id === user.id ? appSession.data.deviceId : undefined;
  const [categoryPolicy, approvalConfig, devices, freeIpaEnabledRaw, passkeys, phones, apiKeys, rawAppName, rawAppUrl, openAiApiEnabled] =
    await Promise.all([
      readAccountCategoryPolicy(),
      appApproval.config(false).catch(() => null),
      session
        ? appApproval.listDevices({ userId: session.user.id, sid: session.data.sid, admin: isAdmin }).catch(() => null)
        : Promise.resolve(null),
      coreSettings.get<boolean>("freeipa.enable"),
      webauthn.listForUser({ userId: user.id }),
      phonesAvailable ? pwaDevices.list({ userId: user.id }, currentDeviceId) : Promise.resolve(null),
      serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
      coreSettings.get<string>("app.name"),
      coreSettings.get<string>("app.url"),
      coreSettings.get<boolean>("ai.openai_api_enabled"),
    ]);
  const availability = approvalAvailability(approvalConfig);
  const cloudUrl = publicCloudOrigin(rawAppUrl);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.securityAndDevices }]}
    >
      <SecurityScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
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
        phones={
          phones ? { devices: phones, dateConfig: getDateConfig(c), summary: t.pwaDescription({ cloud: rawAppName || "Cloud" }) } : null
        }
        apiKeys={{
          keys: apiKeys,
          openAiBaseUrl: openAiApiEnabled ? `${cloudUrl}/api/ai/openai/v1` : null,
          mcpEndpoint: cloudMcpResourceUri(rawAppUrl),
          cloudUrl,
        }}
        now={new Date().toISOString()}
      />
    </Layout>
  );
});
