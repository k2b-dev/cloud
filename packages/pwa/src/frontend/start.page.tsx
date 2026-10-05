import { PWA_AUTH_PATH, PWA_SCOPE } from "@k2b/cloud/contracts";
import { type AuthContext, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { appIconVersion } from "@k2b/cloud/services/branding/app-icon-source";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { getRuntimeContext, PwaLayout, visiblePwaParts } from "@k2b/cloud/ssr";
import { createNavigation, IconButtonLink, installationPlatform, Navigation, Placeholder } from "@k2b/ui";
import { ssr } from "../config";
import { shellMessages } from "../messages";
import PairingNotice from "./_components/PairingNotice.island";
import SignOut from "./_components/SignOut.island";
import Unavailable from "./_components/Unavailable.island";
import Welcome from "./_components/Welcome.island";

const WELCOME_STATES = ["new", "ended", "expired"] as const;
type WelcomeState = (typeof WELCOME_STATES)[number];
const isWelcomeState = (value: string | undefined): value is WelcomeState => WELCOME_STATES.some((state) => state === value);

/**
 * `/pwa/`, the app's start URL. With an app session it is Start; otherwise it shows the state the launch bounce
 * named, or sends the phone through that bounce first, which renews a paired phone without a visible step.
 */
export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = getUserBackedActor(c);
  const locale = getLocale(c);
  const { t } = shellMessages.resolve([locale]);
  const cloud = c.get("settings")?.app?.name || "Cloud";

  if (user) {
    const parts = visiblePwaParts(getRuntimeContext(c).apps, user, locale);
    const apps = createNavigation({
      items: () =>
        parts.map((part) => ({ id: part.id, label: part.name, description: part.description, icon: part.icon, href: part.pwa.href })),
    });
    return () => (
      <PwaLayout
        c={c}
        title={cloud}
        // Settings sits in the header, as in a phone's own apps, so Start stays one list of parts.
        actions={
          <IconButtonLink href={`${PWA_SCOPE}settings`} label={t.settings} tooltip={false}>
            <i class="ti ti-settings" aria-hidden="true" />
          </IconButtonLink>
        }
      >
        <div class="pwa-start">
          {parts.length > 0 ? (
            <Navigation navigation={apps} label={t.apps} />
          ) : (
            <Placeholder icon="ti ti-apps" title={t.noApps} description={t.noAppsDescription} />
          )}
        </div>
        <PairingNotice name={user.displayName || user.uid} />
      </PwaLayout>
    );
  }

  const state = c.req.query("pwa");
  if (state === "blocked") {
    return () => (
      <PwaLayout c={c} title={cloud}>
        <Placeholder icon="ti ti-lock" title={t.blocked} description={t.blockedDetail} action={<SignOut cloud={cloud} />} />
        <PairingNotice />
      </PwaLayout>
    );
  }
  // The launch marker without a session means the bounce could not renew: stop instead of bouncing again.
  if (state === "unavailable" || (!isWelcomeState(state) && c.req.query("pwa_launch") !== undefined)) {
    return () => (
      <PwaLayout c={c} title={cloud}>
        <Placeholder icon="ti ti-cloud-off" title={t.unreachable({ cloud })} action={<Unavailable />} />
        <PairingNotice />
      </PwaLayout>
    );
  }
  if (!isWelcomeState(state)) return c.redirect(`${PWA_AUTH_PATH}/session/launch?to=${encodeURIComponent(PWA_SCOPE)}`, 302);

  const icon = `/branding/pwa-icon-192.png?v=${await appIconVersion()}`;
  const platform = installationPlatform(c.req.header("User-Agent") ?? "", "", 0);
  // Behind the gateway the request URL names an internal hop; the public address is the configured one.
  const url = `${publicCloudOrigin(c.get("settings")?.app?.url || "localhost:3000")}${PWA_SCOPE}`;
  return () => (
    <PwaLayout c={c} title={cloud}>
      <Welcome state={state} cloud={cloud} icon={icon} platform={platform} url={url} />
    </PwaLayout>
  );
});
