import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, readAccountCategoryPolicy } from "@k2b/cloud/services";
import { canManageAnyGroups, groupDisplayName } from "@k2b/cloud/shared";
import { getRuntimeContext, hasDedicatedRuntimeRoute, Layout } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ButtonLink, NoticeCard, SettingsSection } from "@k2b/ui";
import { ssr } from "../../config";
import AccountHub, { AccountPage, AccountProfileActions } from "./AccountHub";
import { pwaAvailable } from "./app-availability";
import { accountMessages } from "./messages";
import RequestFreeIpaAccount from "./RequestFreeIpaAccount.island";
import WithdrawAccountRequest from "./WithdrawAccountRequest.island";

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
  const appName = rawAppName || "Cloud";
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const accountsUiAvailable = hasDedicatedRuntimeRoute(getRuntimeContext(c).apps, "/app/accounts/groups", "core");
  const showAllGroups = c.req.query("groups") === "all";
  const directGroups = user.memberofGroup;
  const displayGroups = showAllGroups
    ? (await accountsAppService.user.group.list({ userId: user.id, recursive: true })).items
    : directGroups;
  const pendingRequest = user.provider === "local" ? await accountsAppService.accountRequest.getPendingForUser({ userId: user.id }) : null;
  const canManageGroups = canManageAnyGroups(user);

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.access }]}>
      <AccountHub appTab={pwaAvailable(c)} user={user} active="access" loginLabel={categoryPolicy.login.label}>
        <AccountPage
          title={t.accessAndGroups}
          description={t.accessDescription}
          actions={
            <>
              {accountsUiAvailable && (
                <ButtonLink href="/app/accounts/groups" variant="secondary" size="sm">
                  <i class="ti ti-users-group" aria-hidden="true" />
                  {t.browseGroups}
                </ButtonLink>
              )}
              <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["extend"]} />
            </>
          }
        >
          {user.provider === "local" && ((requestsEnabled && freeIpaEnabled && categoryPolicy.freeipa.enabled) || pendingRequest) && (
            <SettingsSection title={t.freeIpaAccount} subtitle={t.freeIpaAccountDescription}>
              {pendingRequest ? (
                <div class="flex flex-col gap-3">
                  <NoticeCard tone="info" icon={false}>
                    {t.requestPendingSince({ date: dates.formatDate(pendingRequest.createdAt.toISOString(), { locale }) })}
                  </NoticeCard>
                  <div class="flex justify-end">
                    <WithdrawAccountRequest />
                  </div>
                </div>
              ) : (
                // Islands render as display: contents, so the section's spacing needs a real box.
                <div>
                  <RequestFreeIpaAccount
                    givenname={user.givenname}
                    sn={user.sn}
                    displayName={user.displayName}
                    phone={null}
                    agbUrl="/legal/terms"
                    privacyUrl="/legal/privacy"
                    appName={appName}
                  />
                </div>
              )}
            </SettingsSection>
          )}

          <div class="grid gap-8 lg:grid-cols-2">
            <SettingsSection
              title={
                <>
                  {t.groupMemberships} <span class="font-normal text-dimmed">{displayGroups.length}</span>
                </>
              }
              subtitle={t.groupMembershipsDescription}
              actions={
                displayGroups.length > 0 && (
                  <ButtonLink href={showAllGroups ? "/me/access" : "/me/access?groups=all"} variant="ghost" size="sm">
                    <i class="ti ti-git-branch" aria-hidden="true" />
                    {showAllGroups ? t.directOnly : t.showInherited}
                  </ButtonLink>
                )
              }
            >
              {displayGroups.length > 0 ? (
                <div class="flex flex-wrap gap-1.5">
                  {displayGroups.map((group) => {
                    const isDirect = directGroups.includes(group);
                    const label = (
                      <>
                        {groupDisplayName(group, locale)}
                        {!isDirect && <i class="ti ti-git-branch ml-0.5 text-[10px] opacity-70" />}
                      </>
                    );
                    const className = `tag ${
                      isDirect
                        ? "bg-zinc-100 text-secondary dark:bg-zinc-800"
                        : "bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
                    }`;
                    return accountsUiAvailable ? (
                      <a
                        href={`/app/accounts/groups?scope=member&search=${encodeURIComponent(group)}`}
                        class={`${className} transition-colors hover:text-primary`}
                        title={isDirect ? t.directMembership : t.inheritedMembership}
                      >
                        {label}
                      </a>
                    ) : (
                      <span class={className} title={isDirect ? t.directMembership : t.inheritedMembership}>
                        {label}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p class="text-xs text-dimmed">{t.noGroups}</p>
              )}
            </SettingsSection>

            <SettingsSection
              title={
                <>
                  {t.delegatedManagement} <span class="font-normal text-dimmed">{canManageGroups ? user.manages.length : 0}</span>
                </>
              }
              subtitle={t.delegatedManagementDescription}
            >
              {canManageGroups && user.manages.length > 0 ? (
                <div class="flex flex-wrap gap-1.5">
                  {user.manages.map((group) =>
                    accountsUiAvailable ? (
                      <a
                        href={`/app/accounts/groups?scope=managed&search=${encodeURIComponent(group)}`}
                        class="tag bg-blue-100 text-blue-700 transition-colors hover:text-primary dark:bg-blue-900/50 dark:text-blue-300"
                      >
                        {groupDisplayName(group, locale)}
                      </a>
                    ) : (
                      <span class="tag bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                        {groupDisplayName(group, locale)}
                      </span>
                    ),
                  )}
                </div>
              ) : (
                <p class="text-xs text-dimmed">{t.noManagedGroups}</p>
              )}
            </SettingsSection>
          </div>
        </AccountPage>
      </AccountHub>
    </Layout>
  );
});
