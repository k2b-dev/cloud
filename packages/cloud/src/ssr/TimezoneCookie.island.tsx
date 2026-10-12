import { onMount } from "solid-js";
import { syncTimezoneCookie } from "./timezone-cookie";

export type TimezoneCookieProps = {
  /** Reload once after a timezone change, so the page shows times in the browser's zone. Defaults to `true`. */
  reload?: boolean;
};

/** The timezone cookie for layouts without the shell runtime: `MinimalLayout` and `PwaLayout`. */
export default function TimezoneCookie(props: TimezoneCookieProps) {
  onMount(() => syncTimezoneCookie(props.reload !== false));
  return null;
}
