import { PWA_AUTH_PATH, PWA_COOKIES, PWA_SCOPE } from "@k2b/cloud/contracts";
import { rememberedPwaAddress } from "@k2b/cloud/contracts/pwa-location";
import { type AuthContext, getLocale, getUserBackedActor } from "@k2b/cloud/server";
import { appIconVersion } from "@k2b/cloud/services/branding/app-icon-source";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { getDisplayRuntimeContext, PwaLayout, visiblePwaParts } from "@k2b/cloud/ssr";
import { installationPlatform } from "@k2b/ui";
import { deleteCookie, getCookie } from "hono/cookie";
import { ssr } from "../config";
import { shellMessages } from "../messages";
import StartScreen from "./_components/StartScreen.island";
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

  const remembered = rememberedPwaAddress(getCookie(c, PWA_COOKIES.lastAddress)) ?? PWA_SCOPE;
  if (user && c.req.query("launch") !== undefined) return c.redirect(remembered, 302);

  if (user) {
    const parts = visiblePwaParts(getDisplayRuntimeContext(c).apps, user, locale);
    const starts = parts.map((part) => ({
      id: part.id,
      label: part.name,
      icon: part.icon,
      href: part.pwa.href,
      description: part.description,
      summary: part.pwa.summary,
      color: part.appearance?.accent,
    }));
    const endpoints = [...new Set(parts.flatMap((part) => [part.pwa.badge, part.pwa.summary].filter((path) => path !== undefined)))];
    // Start on v2 in the app's frame, which brings the head and the way to Settings; the island renders the parts.
    return () => (
      <PwaLayout c={c} ui="v2" title={cloud} sidebarTitle={t.start}>
        <StartScreen cloud={cloud} view={{ kind: "parts", parts: starts, endpoints, name: user.displayName || user.uid }} />
      </PwaLayout>
    );
  }

  const state = c.req.query("pwa");
  if (state === "blocked") {
    return () => (
      <PwaLayout c={c} ui="v2" title={cloud}>
        <StartScreen cloud={cloud} view={{ kind: "blocked" }} />
      </PwaLayout>
    );
  }
  // The launch marker without a session means the bounce could not renew: stop instead of bouncing again.
  if (state === "unavailable" || (!isWelcomeState(state) && c.req.query("pwa_launch") !== undefined)) {
    return () => (
      <PwaLayout c={c} ui="v2" title={cloud}>
        <StartScreen cloud={cloud} view={{ kind: "unavailable" }} />
      </PwaLayout>
    );
  }
  if (!isWelcomeState(state)) return c.redirect(`${PWA_AUTH_PATH}/session/launch?to=${encodeURIComponent(remembered)}`, 302);

  const icon = `/branding/pwa-icon-192.png?v=${await appIconVersion()}`;
  // iPadOS Safari reports a Mac; Welcome renders both variants and CSS selects by pointer.
  const platform = installationPlatform(c.req.header("User-Agent") ?? "", "", 0);
  // Behind the gateway the request URL names an internal hop; the public address is the configured one.
  const url = `${publicCloudOrigin(c.get("settings")?.app?.url || "localhost:3000")}${PWA_SCOPE}`;
  // The launch marks a pairing it found ended; the address alone never deletes drafts.
  const ended = state === "ended" && getCookie(c, PWA_COOKIES.ended) === "1";
  if (ended) deleteCookie(c, PWA_COOKIES.ended, { path: PWA_SCOPE, secure: true, httpOnly: true, sameSite: "Lax" });
  // k2b-ui gap: the welcome chooses its installed and its browser variant, and touch or pointer, by CSS in its first
  // picture; v2 has no part for that and no installation guide, so the welcome stays on the v1 frame for now.
  return () => (
    <PwaLayout c={c} title={cloud}>
      <Welcome state={state} cloud={cloud} icon={icon} platform={platform} url={url} clearDrafts={ended} />
    </PwaLayout>
  );
});
