import { cloudMcpResourceUri, publicCloudOrigin } from "@k2b/cloud/api";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { coreSettings, readAccountCategoryPolicy, serviceAccountCredentials } from "@k2b/cloud/services";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { accountUserView } from "./account-view";
import { pwaAvailable } from "./app-availability";
import DeveloperScreen from "./DeveloperScreen.island";
import { accountMessages } from "./messages";
import { profileActionsUser } from "./profile-actions-user";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const { t } = accountMessages.resolve([getLocale(c)]);
  const [rawAppName, rawAppUrl, freeIpaEnabledRaw, apiKeys, openAiApiEnabled] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<string>("app.url"),
    coreSettings.get<boolean>("freeipa.enable"),
    serviceAccountCredentials.listForDelegatedUser({ userId: user.id }),
    coreSettings.get<boolean>("ai.openai_api_enabled"),
  ]);
  const cloudUrl = publicCloudOrigin(rawAppUrl);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.developer }]}>
      <DeveloperScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        appTab={pwaAvailable(c)}
        actionsUser={profileActionsUser(user)}
        appName={rawAppName || "Cloud"}
        freeIpaEnabled={Boolean(freeIpaEnabledRaw)}
        apiKeys={apiKeys}
        openAiBaseUrl={openAiApiEnabled ? `${cloudUrl}/api/ai/openai/v1` : null}
        mcpEndpoint={cloudMcpResourceUri(rawAppUrl)}
        cloudUrl={cloudUrl}
        now={new Date().toISOString()}
      />
    </Layout>
  );
});
