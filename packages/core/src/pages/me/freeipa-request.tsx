import { apiClient } from "@k2b/cloud/clients/core";
import { Button, Check, confirm, Dialog, Field, Input, Notice, Text, useToast } from "@k2b/ui/v2";
import { createSignal, type JSX, Show } from "solid-js";
import { useAccountMessages } from "./AccountWorkspace";

/**
 * Requesting a FreeIPA account and withdrawing a pending request. The request first saves the name, then submits the
 * request, as before; the dialog stays open with the error in place when either fails.
 */
export const useFreeIpaRequest = (props: { givenname: string; sn: string; displayName: string; appName: string }) => {
  const t = useAccountMessages();
  const toast = useToast();
  const [open, setOpen] = createSignal(false);
  const [firstName, setFirstName] = createSignal(props.givenname);
  const [lastName, setLastName] = createSignal(props.sn);
  const [displayName, setDisplayName] = createSignal(props.displayName);
  const [phone, setPhone] = createSignal("");
  const [comment, setComment] = createSignal("");
  const [accepted, setAccepted] = createSignal(false);
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const required = (value: string) => (tried() && !value.trim() ? t().fieldRequired : undefined);

  const submit = async () => {
    setTried(true);
    if (busy() || !firstName().trim() || !lastName().trim() || !accepted()) return;
    setBusy(true);
    setError(null);
    try {
      const profileRes = await apiClient.me.$patch({
        json: { givenname: firstName(), sn: lastName(), displayName: displayName() || `${firstName()} ${lastName()}` },
      });
      if (!profileRes.ok) throw new Error(t().requestProfileUpdateFailed);
      const res = await apiClient.me["account-request"].$post({
        json: { phone: phone() || undefined, comment: comment() || undefined, acceptedAgb: true },
      });
      if (!res.ok) throw new Error(t().requestSubmitFailed);
      setOpen(false);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().requestSubmitFailed);
    } finally {
      setBusy(false);
    }
  };

  const [withdrawing, setWithdrawing] = createSignal(false);
  const withdraw = async () => {
    const agreed = await confirm({
      title: t().withdrawRequest,
      description: t().withdrawConfirm,
      confirm: t().withdraw,
      cancel: t().cancel,
    });
    if (!agreed || withdrawing()) return;
    setWithdrawing(true);
    const res = await apiClient.me["account-request"].$delete().catch(() => null);
    if (res?.ok) return window.location.reload();
    setWithdrawing(false);
    toast(t().withdrawFailed, { status: "bad" });
  };

  const dialogs = (): JSX.Element => (
    <>
      <Dialog
        title={t().requestAccountTitle({ appName: props.appName })}
        open={open()}
        onOpenChange={(next) => !busy() && setOpen(next)}
        foot={
          <>
            <Button disabled={busy()} onClick={() => setOpen(false)}>
              {t().cancel}
            </Button>
            <Button variant="primary" busy={busy()} disabled={!accepted()} onClick={() => void submit()}>
              {t().submitRequest}
            </Button>
          </>
        }
      >
        <Notice tone="note" icon="info-circle">
          {t().verifyRequestDetails}
        </Notice>
        <Field.Row>
          <Field name="firstName" label={t().firstName} error={required(firstName())} required>
            <Input value={firstName()} onInput={setFirstName} placeholder={t().yourFirstNamePlaceholder} />
          </Field>
          <Field name="lastName" label={t().lastName} error={required(lastName())} required>
            <Input value={lastName()} onInput={setLastName} placeholder={t().yourLastNamePlaceholder} />
          </Field>
        </Field.Row>
        <Field name="displayName" label={t().displayName} optional={t().optional}>
          <Input value={displayName()} onInput={setDisplayName} placeholder={t().displayNameQuestion} />
        </Field>
        <Field name="phone" label={t().phone} optional={t().optional}>
          <Input type="tel" value={phone()} onInput={setPhone} placeholder={t().yourPhonePlaceholder} />
        </Field>
        <Field name="comment" label={t().whyFreeIpa} hint={t().freeIpaReasonDescription} optional={t().optional}>
          <Input multiline value={comment()} onInput={setComment} placeholder={t().freeIpaReasonPlaceholder} />
        </Field>
        <Check
          name="acceptedAgb"
          checked={accepted()}
          onChange={setAccepted}
          label={
            <>
              {t().termsPrefix} <Text href="/legal/terms">{t().termsOfService}</Text> {t().and}{" "}
              <Text href="/legal/privacy">{t().privacyPolicy}</Text>.
            </>
          }
        />
        <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      </Dialog>
      <Dialog
        title={t().requestSubmittedTitle}
        open={submitted()}
        onOpenChange={(next) => {
          if (!next) window.location.reload();
        }}
        foot={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t().close}
          </Button>
        }
      >
        <Text>{t().requestSubmittedBody}</Text>
      </Dialog>
    </>
  );

  return { request: () => setOpen(true), withdraw: () => void withdraw(), withdrawing, dialogs };
};
