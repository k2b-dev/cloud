import { useLocale } from "@k2b/ui";
import { Notice } from "@k2b/ui/v2";
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
    <Notice
      tone="bad"
      title={t().passwordChangedSignOutFailed}
      actions={[
        { label: retrying() ? t().signingOutOthers : t().tryAgain, icon: "refresh", disabled: retrying(), onClick: () => void retry() },
        { label: t().continueWithoutSignOut, href: afterSignInHref(props.redirectTo) },
      ]}
    >
      <span role="alert">{t().signOutOthersRetryHint}</span>
    </Notice>
  );
}
