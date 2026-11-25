import { useLocale } from "@k2b/ui";
import { Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { ApprovalError } from "./client";
import { appApprovalMessages } from "./messages";

export default function ApprovalFeedback(props: { error: unknown; returnTo?: string; beforeReauthenticate?: () => void }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [logoutFailed, setLogoutFailed] = createSignal(false);
  const code = () => (props.error instanceof ApprovalError ? props.error.code : "UNKNOWN");
  const recent = () => code() === "REAUTHENTICATE" || (props.error instanceof ApprovalError && props.error.status === 401);
  const message = () =>
    recent()
      ? t().recent
      : code() === "ACCOUNT_MISMATCH"
        ? t().accountMismatch
        : code() === "FORBIDDEN"
          ? t().forbidden
          : code() === "CONFLICT"
            ? t().conflict
            : code() === "LIMIT_REACHED"
              ? t().limit
              : code() === "UNAVAILABLE"
                ? t().unavailable
                : t().failure;
  const reauthenticate = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      props.beforeReauthenticate?.();
      const target = new URL(props.returnTo ?? "/me/security", window.location.origin);
      target.searchParams.set("reauthenticate", "1");
      window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search })}`);
    } catch {
      setLogoutFailed(true);
      setBusy(false);
    }
  };
  return (
    <Show when={props.error}>
      <Notice
        tone="bad"
        actions={
          recent() ? [{ label: t().reauthenticate, icon: "login-2", disabled: busy(), onClick: () => void reauthenticate() }] : undefined
        }
      >
        {logoutFailed() ? t().failure : message()}
      </Notice>
    </Show>
  );
}
