import { PWA_LIMITS, PWA_SCOPE } from "@k2b/cloud/contracts";
import { type AuthContext, buildMetadata, expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { pwaDevices } from "@k2b/cloud/services";
import { formatDate, readThemePreferenceFromCookieHeader } from "@k2b/cloud/shared";
import { PwaLayout } from "@k2b/cloud/ssr";
import { StatusRow } from "@k2b/ui/v2";
import { ssr } from "../config";
import { shellMessages } from "../messages";
import SettingsScreen from "./_components/SettingsScreen.island";

/** `/pwa/settings`: this device only (its name and signing out), the way to Cloud's own settings, and the look. */
export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = expectUserBackedActor(c);
  const locale = getLocale(c);
  const { t } = shellMessages.resolve([locale]);
  const cloud = c.get("settings")?.app?.name || "Cloud";
  const device = await pwaDevices.current(c);

  return () => (
    // Settings on v2 in the app's frame, with its way back to Start beside a phone's tab bar.
    <PwaLayout
      c={c}
      ui="v2"
      title={t.settings}
      back={{ href: PWA_SCOPE, label: t.back, withSidebar: false }}
      // what this page holds, in one line; "Alle Einstellungen" leads to the rest
      status={<StatusRow lead={t.onlyThisDevice} />}
    >
      <SettingsScreen
        account={{ id: user.id }}
        pairedSince={device ? formatDate(device.createdAt, { locale }) : undefined}
        theme={readThemePreferenceFromCookieHeader(c.req.header("Cookie"))}
        name={device?.name ?? ""}
        nameMaxLength={PWA_LIMITS.nameMaxLength}
        cloud={cloud}
        version={t.version({ version: buildMetadata.version })}
      />
    </PwaLayout>
  );
});
