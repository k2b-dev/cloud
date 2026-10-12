import { cookies } from "@k2b/stdlib/browser";
import { TIMEZONE_COOKIE } from "../shared/time";

/**
 * Stores the browser's timezone for server-rendered times. With `reload`, a
 * changed timezone reloads the page once, so it shows times in that zone.
 */
export const syncTimezoneCookie = (reload: boolean) => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const current = cookies.readCookie(TIMEZONE_COOKIE);
  if (!timeZone || current === timeZone) return;
  cookies.writeCookie(TIMEZONE_COOKIE, timeZone);
  if (!reload) return;
  try {
    if (sessionStorage.getItem("cloud.timezone.reload") !== timeZone) {
      sessionStorage.setItem("cloud.timezone.reload", timeZone);
      window.location.reload();
    }
  } catch {
    // Cookie persistence still succeeds; the next navigation will render with the browser timezone.
  }
};
