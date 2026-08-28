import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { audit, coreSettings, webauthn } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AccountActivity from "./AccountActivity.island";
import AccountHub, { AccountPageHeader } from "./AccountHub";
import { accountMessages } from "./messages";
import PasskeysSettings from "./PasskeysSettings.island";
import ProfileSettings from "./ProfileSettings.island";

const parseActivityDays = (value: string | undefined): 7 | 30 | 90 => {
  if (value === "7") return 7;
  if (value === "90") return 90;
  return 30;
};

export default ssr<AuthContext>(async (c) => {
  const user = c.get("user");
  const { t } = accountMessages.resolve([getLocale(c)]);
  const activityDays = parseActivityDays(c.req.query("activityDays"));
  const [freeIpaEnabledRaw, passkeys, activityPage] = await Promise.all([
    coreSettings.get<boolean>("freeipa.enable"),
    webauthn.listForUser({ userId: user.id }),
    audit.listSelfServiceActivity({ userId: user.id, days: activityDays, pagination: { page: 1, perPage: 50 } }),
  ]);

  return () => (
    <Layout c={c} title={[{ title: t.start, href: "/" }, { title: t.account, href: "/me" }, { title: t.security }]}>
      <AccountHub user={user} active="security">
        <div class="flex flex-col gap-2">
          <AccountPageHeader title={t.security} description={t.securityDescription} />
          <PasskeysSettings initialPasskeys={passkeys} />
          <ProfileSettings provider={user.provider} profile={user.profile} freeIpaEnabled={Boolean(freeIpaEnabledRaw)} />
          <AccountActivity initialItems={activityPage.items} days={activityDays} />
        </div>
      </AccountHub>
    </Layout>
  );
});
