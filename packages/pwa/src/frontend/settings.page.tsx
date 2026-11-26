import { type AuthContext, buildMetadata, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { pwaDevices } from "@k2b/cloud/services";
import { readThemePreferenceFromCookieHeader } from "@k2b/cloud/shared";
import { PwaLayout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { shellMessages } from "../messages";
import SettingsScreen from "./_components/SettingsScreen.island";

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
    // Settings on v2: its own workspace; Start stays in the tab bar and the sidebar, so no way back is added.
    <PwaLayout c={c} ui="v2" bare title={t.settings}>
      <SettingsScreen
        account={{ id: user.id, name, mail: user.mail || undefined, avatar }}
        theme={readThemePreferenceFromCookieHeader(c.req.header("Cookie"))}
        name={device?.name ?? ""}
        cloud={cloud}
        version={t.version({ version: buildMetadata.version })}
      />
    </PwaLayout>
  );
});
