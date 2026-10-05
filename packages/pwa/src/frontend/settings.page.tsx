import { PWA_SCOPE } from "@k2b/cloud/contracts";
import { type AuthContext, buildMetadata, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { pwaDevices } from "@k2b/cloud/services";
import { readThemeFromCookieHeader } from "@k2b/cloud/shared";
import { PwaLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { shellMessages } from "../messages";
import PhoneSettings from "./_components/PhoneSettings.island";

/** `/pwa/settings`: the account, language and appearance, this phone's name, and signing out of the app. */
export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = expectUserBackedActor(c);
  const locale = getLocale(c);
  const { t } = shellMessages.resolve([locale]);
  const cloud = c.get("settings")?.app?.name || "Cloud";
  const device = await pwaDevices.current(c);
  const name = user.displayName || user.uid;
  const avatar = user.avatarHash
    ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}`
    : undefined;

  return () => (
    <PwaLayout c={c} title={t.settings} back={{ href: PWA_SCOPE, label: t.back }}>
      <PhoneSettings
        account={{ name, mail: user.mail || undefined, avatar }}
        theme={readThemeFromCookieHeader(c.req.header("Cookie"))}
        name={device?.name ?? ""}
        cloud={cloud}
        version={t.version({ version: buildMetadata.version })}
      />
    </PwaLayout>
  );
});
