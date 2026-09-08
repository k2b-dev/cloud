import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { signOutCurrentSession } from "../me/account-session";
import { ApprovalError } from "./client";
import { appApprovalMessages } from "./messages";

export default function ApprovalFeedback(props: { error: unknown; returnTo?: string }) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const [logoutFailed, setLogoutFailed] = createSignal(false);
  const code = () => (props.error instanceof ApprovalError ? props.error.code : "UNKNOWN");
  const recent = () => code() === "REAUTHENTICATE" || (props.error instanceof ApprovalError && props.error.status === 401);
  const message = () =>
    recent()
      ? t().recent
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
      await signOutCurrentSession(t().failure, props.returnTo ?? "/me/security");
    } catch {
      setLogoutFailed(true);
      setBusy(false);
    }
  };
  return (
    <Show when={props.error}>
      <NoticeCard tone="danger">
        <div role="alert" class="flex flex-col gap-2">
          <p>{logoutFailed() ? t().failure : message()}</p>
          <Show when={recent()}>
            <Button variant="secondary" loading={busy()} onClick={reauthenticate}>
              {t().reauthenticate}
            </Button>
          </Show>
        </div>
      </NoticeCard>
    </Show>
  );
}
