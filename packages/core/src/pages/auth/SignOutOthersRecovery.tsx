import { Button, ButtonLink, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { retrySignOutOthers, signOutOthersRetryPath } from "../sign-out-others";
import { afterSignInHref } from "./login-redirect";
import { authMessages } from "./messages";

/** Shown after a password change signed this browser in but could not end the other sign-ins. */
export function SignOutOthersRecovery(props: { redirectTo?: string }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [retrying, setRetrying] = createSignal(false);

  const retry = async () => {
    setRetrying(true);
    const outcome = await retrySignOutOthers();
    if (outcome === "signed-out") window.location.href = afterSignInHref(props.redirectTo);
    // Without a usable browser sign-in (ended, or terms not yet accepted), sign-in or consent comes back to this retry.
    else if (outcome === "sign-in-again") window.location.href = afterSignInHref(signOutOthersRetryPath(window.location.href));
    else setRetrying(false);
  };

  return (
    <NoticeCard tone="danger" role="alert" title={t().passwordChangedSignOutFailed} detail={t().signOutOthersRetryHint}>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" loading={retrying()} loadingLabel={t().signingOutOthers} onClick={() => void retry()}>
          <i class="ti ti-refresh" />
          <span>{t().tryAgain}</span>
        </Button>
        <ButtonLink size="sm" variant="secondary" navigation="document" href={afterSignInHref(props.redirectTo)}>
          {t().continueWithoutSignOut}
        </ButtonLink>
      </div>
    </NoticeCard>
  );
}
