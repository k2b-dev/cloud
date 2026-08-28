import { dates } from "@k2b/stdlib";
import { ButtonLink, NoticeCard } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService, coreSettings } from "@valentinkolb/cloud/services";
import { canManageAnyGroups } from "@valentinkolb/cloud/shared";
import { getRuntimeContext, hasDedicatedRuntimeRoute, Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountProfileActions } from "./AccountHub";
import { accountMessages } from "./messages";
import RequestFreeIpaAccount from "./RequestFreeIpaAccount.island";
import WithdrawAccountRequest from "./WithdrawAccountRequest.island";

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
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
      <AccountHub user={user} active="access">
        <div class="flex flex-col gap-2">
          <AccountPageHeader
            title={t.accessAndGroups}
            description={t.accessDescription}
            actions={
              <div class="flex flex-wrap items-center gap-2">
                {accountsUiAvailable && (
                  <ButtonLink href="/app/accounts/groups" variant="secondary" size="sm">
                    <i class="ti ti-users-group" />
                    {t.browseGroups}
                  </ButtonLink>
                )}
                <AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} actions={["extend"]} />
              </div>
            }
          />

          <section class="paper p-5 sm:p-6">
            <div class="grid gap-5 sm:grid-cols-3">
              <div>
                <p class="section-label mb-1">{t.provider}</p>
                <p class="text-sm font-medium text-primary">{user.provider === "ipa" ? "FreeIPA" : t.localAccount}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.directMemberships}</p>
                <p class="text-sm font-medium text-primary">{directGroups.length}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.managedGroups}</p>
                <p class="text-sm font-medium text-primary">{user.manages.length}</p>
              </div>
            </div>
          </section>

          {user.provider === "local" && (freeIpaEnabled || pendingRequest) && (
            <section class="paper p-5 sm:p-6">
              <div class="mb-4">
                <h3 class="text-sm font-semibold text-primary">{t.freeIpaAccount}</h3>
                <p class="mt-1 text-xs text-dimmed">{t.freeIpaAccountDescription}</p>
              </div>
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
                <RequestFreeIpaAccount
                  givenname={user.givenname}
                  sn={user.sn}
                  displayName={user.displayName}
                  phone={null}
                  agbUrl="/legal/terms"
                  privacyUrl="/legal/privacy"
                  appName={appName}
                />
              )}
            </section>
          )}

          <section class="grid gap-2 lg:grid-cols-2">
            <div class="paper p-5 sm:p-6">
              <div class="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold text-primary">{t.groupMemberships}</h3>
                  <p class="mt-1 text-xs text-dimmed">{t.groupMembershipsDescription}</p>
                </div>
                {displayGroups.length > 0 && (
                  <ButtonLink href={showAllGroups ? "/me/access" : "/me/access?groups=all"} variant="ghost" size="sm" class="shrink-0">
                    <i class="ti ti-git-branch" />
                    {showAllGroups ? t.directOnly : t.showInherited}
                  </ButtonLink>
                )}
              </div>
              {displayGroups.length > 0 ? (
                <div class="flex flex-wrap gap-1.5">
                  {displayGroups.map((group) => {
                    const isDirect = directGroups.includes(group);
                    const label = (
                      <>
                        {group}
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
                <p class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4 text-xs text-dimmed">{t.noGroups}</p>
              )}
            </div>

            <div class="paper p-5 sm:p-6">
              <div class="mb-4">
                <h3 class="text-sm font-semibold text-primary">{t.delegatedManagement}</h3>
                <p class="mt-1 text-xs text-dimmed">{t.delegatedManagementDescription}</p>
              </div>
              {canManageGroups && user.manages.length > 0 ? (
                <div class="flex flex-wrap gap-1.5">
                  {user.manages.map((group) =>
                    accountsUiAvailable ? (
                      <a
                        href={`/app/accounts/groups?scope=managed&search=${encodeURIComponent(group)}`}
                        class="tag bg-blue-100 text-blue-700 transition-colors hover:text-primary dark:bg-blue-900/50 dark:text-blue-300"
                      >
                        {group}
                      </a>
                    ) : (
                      <span class="tag bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">{group}</span>
                    ),
                  )}
                </div>
              ) : (
                <p class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4 text-xs text-dimmed">{t.noManagedGroups}</p>
              )}
            </div>
          </section>
        </div>
      </AccountHub>
    </Layout>
  );
});
