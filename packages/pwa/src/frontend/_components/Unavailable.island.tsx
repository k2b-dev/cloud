import { PWA_LIMITS, PWA_SCOPE, PwaRenewResultSchema } from "@k2b/cloud/contracts";
import { Button, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
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

/** Whether a renewal set new app cookies; `undefined` when it did not succeed at all. */
const renew = async (): Promise<boolean | undefined> => {
  const answer = await phoneAuth.renew();
  if (answer.status !== 200) return undefined;
  const parsed = PwaRenewResultSchema.safeParse(answer.body);
  return parsed.success ? parsed.data.renewed : undefined;
};

/**
 * "Try again" for the unavailable state. On load it renews with a request of its own: some platforms drop cookies
 * set on a redirect, and the launch bounce is one. Such a phone still presents the key the bounce has just replaced,
 * which only renews once the rotation grace has passed, so a renewal that sets no cookies is tried once more after it.
 */
export default function Unavailable() {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  onMount(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(timer));
    void (async () => {
      let renewed = await renew();
      if (renewed === false) {
        await new Promise((resolve) => {
          timer = setTimeout(resolve, PWA_LIMITS.rotationGraceSeconds * 1000);
        });
        renewed = await renew();
      }
      if (renewed && mayRetry()) location.replace(PWA_SCOPE);
    })();
  });
  return (
    <Button onClick={() => location.replace(PWA_SCOPE)}>
      <i class="ti ti-refresh" aria-hidden="true" />
      {t().tryAgain}
    </Button>
  );
}
