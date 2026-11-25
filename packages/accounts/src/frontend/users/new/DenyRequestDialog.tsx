import { Button, Dialog, Field, Input, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../../messages";

/**
 * Denies an open account request on v2: who asked, an optional reason that the requester receives by email, and
 * "Deny request". A refusal stays in the dialog with the reason kept, so it can be sent again.
 */
export default function DenyRequestDialog(props: {
  request: { id: string; email: string; firstName: string };
  /** Close the dialog; `denied` when the request is denied and the page must show it. */
  close: (denied: boolean) => void;
}) {
  const t = useAccountsMessages();
  const [reason, setReason] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const deny = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiClient["account-requests"][":id"].deny
        .$post({ param: { id: props.request.id }, json: { reason: reason().trim() || undefined } })
        .catch(() => null);
      if (!response?.ok) {
        const body = z.object({ message: z.string() }).safeParse(await response?.json().catch(() => null));
        setError(body.success ? body.data.message : t().denyRequestFailed);
        return;
      }
      props.close(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().denyAccountRequest}
      open
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => props.close(false)} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="x" busy={busy()} onClick={() => void deny()}>
            {t().denyRequest}
          </Button>
        </>
      }
    >
      <Notice tone="warn">{t().denyConfirm({ name: props.request.firstName, email: props.request.email })}</Notice>
      <Field name="reason" label={t().optionalReason} hint={t().denyReasonDescription}>
        <Input multiline value={reason()} placeholder={t().denyReasonPlaceholder} disabled={busy()} onInput={setReason} />
      </Field>
      <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
    </Dialog>
  );
}
