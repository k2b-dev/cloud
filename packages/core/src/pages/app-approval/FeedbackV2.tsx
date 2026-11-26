import { Notice, useLocale } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { approvalErrorMessage, isRecentSignInRequired } from "./feedback-message";
import { appApprovalMessages } from "./messages";

/**
 * A failed app approval on a v2 page, as `ApprovalFeedback` says it on v1: the reason in words, and "Sign in again"
 * where the step needs a recent sign-in. `beforeReauthenticate` runs first (a pairing forgets its saved request); when
 * it fails, the notice says so and the page stays.
 */
export default function ApprovalFeedbackV2(props: { error: unknown; returnTo?: string; beforeReauthenticate?: () => void }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const reauthenticate = () => {
    if (busy()) return;
    setBusy(true);
    try {
      props.beforeReauthenticate?.();
      const target = new URL(props.returnTo ?? "/me/security", window.location.origin);
      target.searchParams.set("reauthenticate", "1");
      window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search })}`);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <Show when={props.error}>
      {(error) => (
        <Notice
          tone="bad"
          actions={isRecentSignInRequired(error()) ? [{ label: t().reauthenticate, disabled: busy(), onClick: reauthenticate }] : undefined}
        >
          {failed() ? t().failure : approvalErrorMessage(error(), t())}
        </Notice>
      )}
    </Show>
  );
}
