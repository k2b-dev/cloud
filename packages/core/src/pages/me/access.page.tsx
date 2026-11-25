import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { canManageAnyGroups, groupDisplayName } from "@k2b/cloud/shared";
import { getRuntimeContext, hasDedicatedRuntimeRoute, Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../../config";
import AccessScreen from "./AccessScreen.island";
import { accountUserView } from "./account-view";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";
import { profileActionsUser } from "./profile-actions-user";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const requestsEnabled = await accountsAppService.accountRequest.isEnabled();
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const [rawAppName, freeIpaEnabledRaw] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
  ]);
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const accountsUi = hasDedicatedRuntimeRoute(getRuntimeContext(c).apps, "/app/accounts/groups", "core");
  const showInherited = c.req.query("groups") === "all";
  const directGroups = (await accountsAppService.user.group.list({ userId: user.id, recursive: false })).items;
  const displayGroups = showInherited
    ? (await accountsAppService.user.group.list({ userId: user.id, recursive: true })).items
    : directGroups;
  const pendingRequest = user.provider === "local" ? await accountsAppService.accountRequest.getPendingForUser({ userId: user.id }) : null;
  const offered = user.provider === "local" && ((requestsEnabled && freeIpaEnabled && categoryPolicy.freeipa.enabled) || pendingRequest);

  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.access }]}>
      <AccessScreen
        user={accountUserView(user, categoryPolicy.login.label, t)}
        appTab={pwaAvailable(c)}
        actionsUser={profileActionsUser(user)}
        appName={rawAppName || "Cloud"}
        freeIpaEnabled={freeIpaEnabled}
        accountsUi={accountsUi}
        showInherited={showInherited}
        groups={displayGroups.map((name) => ({ name, label: groupDisplayName(name, locale), inherited: !directGroups.includes(name) }))}
        managed={(canManageAnyGroups(user) ? user.manages : []).map((name) => ({ name, label: groupDisplayName(name, locale) }))}
        freeIpa={
          offered ? { pendingSince: pendingRequest ? dates.formatDate(pendingRequest.createdAt.toISOString(), { locale }) : null } : null
        }
      />
    </Layout>
  );
});
