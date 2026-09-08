import { dates } from "@k2b/stdlib";
import { accountCategoryLabel } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { coreSettings, readAccountCategoryPolicy } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountHub, { AccountPageHeader, AccountProfileActions } from "./AccountHub";
import { accountMessages } from "./messages";

const formatAddress = (address: {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
}): string | null => {
  const parts = [address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
};

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const categoryPolicy = await readAccountCategoryPolicy();
  const locale = getLocale(c);
  const { t } = accountMessages.resolve([locale]);
  const [rawAppName, freeIpaEnabledRaw] = await Promise.all([
    coreSettings.get<string>("app.name"),
    coreSettings.get<boolean>("freeipa.enable"),
  ]);
  const appName = rawAppName || "Cloud";
  const freeIpaEnabled = Boolean(freeIpaEnabledRaw);
  const address = formatAddress(user.ipa?.address ?? { street: null, postalCode: null, city: null, state: null });

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.profile }]}>
      <AccountHub user={user} active="profile" loginLabel={categoryPolicy.login.label}>
        <div class="flex flex-col gap-2">
          <AccountPageHeader
            title={t.profileTitle}
            description={t.profileDescription}
            actions={<AccountProfileActions user={user} appName={appName} freeIpaEnabled={freeIpaEnabled} />}
          />

          <section class="paper p-5 sm:p-6">
            <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div>
                <p class="section-label mb-1">{t.displayName}</p>
                <p class="text-sm font-medium text-primary">{user.displayName || user.uid}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.username}</p>
                <p class="text-sm text-secondary">{user.uid}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.email}</p>
                <p class="break-words text-sm text-secondary">{user.mail ?? t.notSet}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.phone}</p>
                <p class="text-sm text-secondary">{user.ipa?.phone ?? t.notSet}</p>
              </div>
              {user.ipa?.mobile && user.ipa.mobile !== user.ipa.phone && (
                <div>
                  <p class="section-label mb-1">{t.mobile}</p>
                  <p class="text-sm text-secondary">{user.ipa.mobile}</p>
                </div>
              )}
              {user.ipa?.employeeType && (
                <div>
                  <p class="section-label mb-1">{t.employeeType}</p>
                  <p class="text-sm text-secondary">{user.ipa.employeeType}</p>
                </div>
              )}
              <div class="sm:col-span-2">
                <p class="section-label mb-1">{t.address}</p>
                <p class="text-sm text-secondary">{address ?? t.notSet}</p>
              </div>
            </div>
          </section>

          <section class="paper p-5 sm:p-6">
            <div class="mb-5">
              <h3 class="text-sm font-semibold text-primary">{t.accountFacts}</h3>
              <p class="mt-1 text-xs text-dimmed">{t.accountFactsDescription}</p>
            </div>
            <div class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div>
                <p class="section-label mb-1">{t.accountType}</p>
                <p class="text-sm text-secondary">{accountCategoryLabel(user, categoryPolicy.login.label)}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.accountExpiry}</p>
                <p class="text-sm text-secondary">{user.accountExpires ? dates.formatDate(user.accountExpires, { locale }) : t.noExpiry}</p>
              </div>
              <div>
                <p class="section-label mb-1">{t.passwordExpiry}</p>
                <p class="text-sm text-secondary">
                  {user.ipa?.passwordExpires ? dates.formatDate(user.ipa.passwordExpires, { locale }) : t.notApplicable}
                </p>
              </div>
              <div>
                <p class="section-label mb-1">{t.sshKeys}</p>
                <p class="text-sm text-secondary">{t.configuredKeys({ count: user.ipa?.sshPublicKeys.length ?? 0 })}</p>
              </div>
            </div>
          </section>
        </div>
      </AccountHub>
    </Layout>
  );
});
