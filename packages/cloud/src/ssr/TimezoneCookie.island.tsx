import { cookies } from "@k2b/stdlib/browser";
import { onMount } from "solid-js";
import { TIMEZONE_COOKIE } from "../shared/time";

export type TimezoneCookieProps = {
  /** Reload once after a timezone change, so the page shows times in the browser's zone. Defaults to `true`. */
  reload?: boolean;
};

export default function TimezoneCookie(props: TimezoneCookieProps) {
  onMount(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const current = cookies.readCookie(TIMEZONE_COOKIE);
    if (timeZone && current !== timeZone) {
      cookies.writeCookie(TIMEZONE_COOKIE, timeZone);
      if (props.reload === false) return;
      try {
        if (sessionStorage.getItem("cloud.timezone.reload") !== timeZone) {
          sessionStorage.setItem("cloud.timezone.reload", timeZone);
          window.location.reload();
        }
      } catch {
        // Cookie persistence still succeeds; the next navigation will render with the browser timezone.
      }
    }
  });

  return null;
}
