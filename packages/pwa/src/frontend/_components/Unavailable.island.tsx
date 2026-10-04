import { PWA_SCOPE } from "@k2b/cloud/contracts";
import { Button, useLocale } from "@k2b/ui";
import { onMount } from "solid-js";
import { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";

/** One automatic return to Start per this window, so a phone that cannot keep cookies never loops. */
const RETRY_MARKER = "cloud.pwa.unavailable-retry";
const RETRY_WINDOW_MS = 30_000;

const mayRetry = (): boolean => {
  try {
    const last = Number(window.sessionStorage.getItem(RETRY_MARKER));
    if (last > 0 && Date.now() - last < RETRY_WINDOW_MS) return false;
    window.sessionStorage.setItem(RETRY_MARKER, String(Date.now()));
    return true;
  } catch {
    return false;
  }
};

/**
 * "Try again" for the unavailable state. On load it renews once with a request of its own: some platforms drop
 * cookies set on a redirect, and the launch bounce is one.
 */
export default function Unavailable() {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  onMount(() => {
    void (async () => {
      if ((await phoneAuth.renew()).status === 200 && mayRetry()) location.replace(PWA_SCOPE);
    })();
  });
  return (
    <Button onClick={() => location.replace(PWA_SCOPE)}>
      <i class="ti ti-refresh" aria-hidden="true" />
      {t().tryAgain}
    </Button>
  );
}
