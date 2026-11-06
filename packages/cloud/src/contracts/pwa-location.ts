import { PWA_AUTH_PATH, PWA_SCOPE } from "./pwa-paths";

const appTarget = (to: string | undefined): URL | undefined => {
  if (!to || to.length > 2048 || !to.startsWith(PWA_SCOPE) || to.includes("//") || to.includes("\\")) return undefined;
  const url = new URL(to, "http://launch.invalid");
  // Judge the path the browser will request: dot segments and escapes are resolved by then.
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const inside = (value: string) => value.startsWith(PWA_SCOPE) && value !== PWA_AUTH_PATH && !value.startsWith(`${PWA_AUTH_PATH}/`);
  if (url.origin !== "http://launch.invalid" || !inside(url.pathname) || !inside(path) || path.includes("//")) return undefined;
  return url;
};

/**
 * A path inside the app to return to after the launch bounce; anything else becomes `/pwa/`.
 * The `pwa_launch` marker lets the page stop instead of bouncing again.
 */
export const launchTarget = (to: string | undefined): string => {
  const url = appTarget(to);
  if (!url) return `${PWA_SCOPE}?pwa_launch=1`;
  url.searchParams.set("pwa_launch", "1");
  return url.pathname + url.search;
};

/** A remembered page, without launch markers or welcome/error states. */
export const rememberedPwaAddress = (to: string | undefined): string | undefined => {
  if (to?.includes("#")) return undefined;
  const url = appTarget(to);
  if (!url || (url.pathname === PWA_SCOPE && url.searchParams.has("pwa")) || decodeURIComponent(url.pathname) === `${PWA_SCOPE}offline`)
    return undefined;
  url.searchParams.delete("pwa_launch");
  if (url.pathname === PWA_SCOPE) url.searchParams.delete("launch");
  return url.pathname + url.search;
};
