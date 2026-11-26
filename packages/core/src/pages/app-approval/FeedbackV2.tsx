import { useLocale } from "@k2b/ui";
import { Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { approvalErrorMessage, isRecentSignInRequired } from "./feedback-message";
import { appApprovalMessages } from "./messages";

/**
 * A failed app approval on a v2 page, as `ApprovalFeedback` says it on v1: the reason in words, and "Sign in again"
 * where the step needs a recent sign-in.
 */
export default function ApprovalFeedbackV2(props: { error: unknown; returnTo?: string }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const reauthenticate = () => {
    if (busy()) return;
    setBusy(true);
    const target = new URL(props.returnTo ?? "/me/security", window.location.origin);
    target.searchParams.set("reauthenticate", "1");
    window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search })}`);
  };
  return (
    <Show when={props.error}>
      {(error) => (
        <Notice
          tone="bad"
          actions={isRecentSignInRequired(error()) ? [{ label: t().reauthenticate, disabled: busy(), onClick: reauthenticate }] : undefined}
        >
          {approvalErrorMessage(error(), t())}
        </Notice>
      )}
    </Show>
  );
}
