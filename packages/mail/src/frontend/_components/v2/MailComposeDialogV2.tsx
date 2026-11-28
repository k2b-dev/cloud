import { type ToastHandle, toast, useLocale } from "@k2b/ui";
import { Button, Dialog, Facts, Field, Notice, Select } from "@k2b/ui/v2";
import { createEffect, createMemo, Match, onCleanup, Show, Switch } from "solid-js";
import type { MailDraft } from "../../../contracts";
import { createMailComposeIntent, type MailComposeIntentProps } from "../mail-compose-intent-state";
import { mailSenderIdentityStatusMessages, senderUnavailableDetail } from "../mail-sender-identity-status";

/**
 * "New message" on UI v2 when it cannot open its window at once (an email link, a Command, more than one mailbox or
 * sender): a dialog over the mailbox with the mailbox and the sender, what an email link brings, and Continue. The
 * choice and the draft are the v1 page's (`createMailComposeIntent`); `open` shows the draft, `onClose` ends the dialog.
 */
export function MailComposeDialogV2(props: MailComposeIntentProps & { open: (draft: MailDraft) => void; onClose: () => void }) {
  const intent = createMailComposeIntent(props, props.open);
  const t = intent.t;
  const locale = useLocale();
  const senderText = createMemo(() => mailSenderIdentityStatusMessages.resolve([locale()]).t);
  // A start that needs no choice opens the window at once: meanwhile a quiet progress toast, as New message in the mailbox.
  createEffect(() => {
    if (!intent.autoStartPending()) return;
    const progress: ToastHandle = toast(t().preparingMessage, { progress: "indeterminate", duration: 0, iconClass: "ti ti-pencil" });
    onCleanup(() => progress.dismiss());
  });
  const blocked = () =>
    !intent.parsedIntent().ok ||
    !intent.selectedMailbox() ||
    !intent.selectedIdentity() ||
    intent.identityLoading() ||
    intent.commandLoading() ||
    Boolean(intent.commandError());
  return (
    <Dialog
      title={t().newMessage}
      open={!intent.autoStartPending()}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      foot={
        <>
          <Button onClick={props.onClose}>{t().cancel}</Button>
          <Button
            variant="primary"
            icon="arrow-right"
            busy={intent.draftCreation.loading()}
            disabled={blocked()}
            onClick={intent.createDraft}
          >
            {t().continue}
          </Button>
        </>
      }
    >
      <Switch>
        <Match when={props.mailboxes.length === 0}>
          <Notice tone="warn" title={t().noWritableMailbox}>
            {t().noWritableMailboxDescription}
          </Notice>
        </Match>
        <Match when={intent.intentError()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Match>
        <Match when={true}>
          <Field label={t().mailbox}>
            <Select
              placeholder={t().chooseMailbox}
              value={intent.mailboxId()}
              onChange={intent.setMailboxId}
              options={props.mailboxes.map((mailbox) => ({ value: mailbox.id, label: mailbox.name }))}
              disabled={intent.draftCreation.loading()}
            />
          </Field>
          <Field label={t().senderField}>
            <Select
              placeholder={intent.identityLoading() ? t().loadingSenders : t().chooseSender}
              value={intent.identityId()}
              onChange={intent.setIdentityId}
              options={intent
                .identities()
                .map((identity) => ({ value: identity.id, label: `${identity.label} · ${identity.fromAddress}` }))}
              disabled={!intent.mailboxId() || intent.identityLoading() || intent.draftCreation.loading()}
            />
          </Field>
          <Show when={intent.mailto()}>
            <Facts
              items={[
                {
                  label: t().emailLink,
                  value: intent.intentData()?.to.length
                    ? intent
                        .intentData()!
                        .to.map((recipient) => recipient.address)
                        .join(", ")
                    : t().noRecipientSupplied,
                },
                ...(intent.intentData()?.subject ? [{ label: t().subject, value: intent.intentData()!.subject }] : []),
              ]}
            />
          </Show>
          {/* at most one notice, last above the foot: what keeps Continue from working, and the one thing to do about it */}
          <Switch>
            <Match when={intent.commandError()}>
              {(error) => (
                <Notice
                  tone="bad"
                  actions={[
                    {
                      label: t().retry,
                      disabled: intent.commandLoading(),
                      onClick: () =>
                        void intent
                          .retryCommand()?.()
                          .catch(() => {}),
                    },
                  ]}
                >
                  {error()}
                </Notice>
              )}
            </Match>
            <Match when={intent.identityError()}>
              {(message) => (
                <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void intent.identityResults.refresh() }]}>
                  {message()}
                </Notice>
              )}
            </Match>
            {/* only for the chosen mailbox's own senders, as on the v1 page */}
            <Match when={intent.senderUnavailable()}>
              <Notice
                tone="warn"
                title={senderText().cannotSend}
                actions={
                  intent.selectedMailbox()?.canManage
                    ? [
                        {
                          label: senderText().openSenderSettings,
                          icon: "settings",
                          disabled: intent.settingsOpening(),
                          onClick: () => void intent.openSenderSettings(),
                        },
                      ]
                    : undefined
                }
              >
                {senderUnavailableDetail(intent.allIdentities(), locale())}
                {intent.selectedMailbox()?.canManage ? "" : ` ${senderText().askAdmin}`}
              </Notice>
            </Match>
          </Switch>
        </Match>
      </Switch>
    </Dialog>
  );
}
