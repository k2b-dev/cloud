import { buildMetadata } from "../_internal/build-metadata";
import { registeredPwaBuilds } from "../_internal/runtime-watcher";
import { PWA_SCOPE } from "../contracts/pwa";
import { pwaBuild } from "../contracts/pwa-builds";
import { getLocale } from "../server/locale";
import { visiblePwaParts } from "./app-navigation";
import type { LayoutContext } from "./layout-context";
import { pwaMessages } from "./pwa-messages";
import { getDisplayRuntimeContext } from "./runtime";

/** Parts with their own tab; Start lists every part and doubles as "More". */
export const TAB_PARTS = 3;

/**
 * What every frame of the installable app knows about the page, shared by the v1 and the v2 frame: the person, the
 * installation's name, the parts they may open, the open part and tab, the builds the runtime compares, and the count
 * routes. It also sets the page's head and framing headers, as every app page does.
 */
export function pwaFrame(c: LayoutContext & { header(name: string, value: string): void }, title: string) {
  const locale = getLocale(c);
  const t = pwaMessages.resolve([locale]).t;
  const user = c.get("user");
  const cloud = c.get("settings")?.app?.name || "Cloud";
  const page = c.get("page");
  page.title = title;
  page.pwa = { name: cloud };
  // No app page may be framed, and none leaks its address to another site.
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");

  const parts = visiblePwaParts(getDisplayRuntimeContext(c).apps, user, locale);
  const path = new URL(c.req.raw.url).pathname;
  const owner = page.pwaOwner;
  const ownBuild = pwaBuild(buildMetadata);
  const coreBuild = registeredPwaBuilds().core;
  const builds = { ...(owner && ownBuild ? { [owner]: ownBuild } : {}), ...(coreBuild ? { core: coreBuild } : {}) };
  // A part's badge calls for attention in the sidebar and on its tab; without one, its summary's count stays quiet in
  // the sidebar. One watcher reads every route of the page.
  const countRoutes = [...new Set(parts.flatMap((part) => [part.pwa.badge, part.pwa.summary].filter((path) => path !== undefined)))];
  const tabs = parts.slice(0, TAB_PARTS);
  const currentTab = tabs.find((part) => path === part.pwa.href || path.startsWith(`${part.pwa.href}/`));
  const settingsHref = `${PWA_SCOPE}settings`;
  const currentPart = parts.find((part) => path === part.pwa.href || path.startsWith(`${part.pwa.href}/`));
  // A part takes its app colour for selection and accents, as an app does on the web; Start and Settings keep Cloud's.
  page.appAccent = currentPart?.appearance?.accent;
  page.appPrimary = currentPart?.appearance?.primary;
  return { locale, t, user, cloud, page, parts, path, builds, countRoutes, tabs, currentTab, settingsHref, currentPart };
}

export type PwaFrame = ReturnType<typeof pwaFrame>;
