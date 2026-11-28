import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Empty, Facts, Field, Inline, Loading, Notice, Pane, Path, Section, Select, Workspace } from "@k2b/ui/v2";
import { createMemo, Show } from "solid-js";
import { createMailComposeIntent, type MailComposeIntentProps } from "./mail-compose-intent-state";
import { mailSenderIdentityStatusMessages, senderUnavailableDetail } from "./mail-sender-identity-status";

/**
 * "New message" on UI v2, before its window opens: the mailbox and the sender it goes out from, the address an email
 * link or a Command brings, and Continue. The choice and the draft are the v1 page's (`createMailComposeIntent`).
 */
export default function MailComposeIntentPageV2(props: MailComposeIntentProps) {
  const intent = createMailComposeIntent(props);
  const t = intent.t;
  const locale = useLocale();
  const senderText = createMemo(() => mailSenderIdentityStatusMessages.resolve([locale()]).t);
  const back = () => intent.returnHref() ?? (intent.selectedMailbox() ? `/app/mail/${intent.selectedMailbox()!.id}` : "/app/mail");
  const blocked = () =>
    !intent.selectedMailbox() ||
    !intent.selectedIdentity() ||
    intent.identityLoading() ||
    intent.draftCreation.loading() ||
    intent.commandLoading() ||
    Boolean(intent.commandError());
  return (
    <Workspace head={<Bar start={<Path label="Mail" items={[{ label: "Mail", href: back() }, { label: t().newMessage }]} />} />}>
      <Pane label={t().newMessage}>
        {/* a start that needs no choice opens the window at once: the place of the form holds its rows meanwhile */}
        <Show when={!intent.autoStartPending()} fallback={<Loading rows={3} />}>
          <Show
            when={props.mailboxes.length > 0}
            fallback={<Empty icon="mail-off" text={`${t().noWritableMailbox}. ${t().noWritableMailboxDescription}`} />}
          >
            <Show when={intent.parsedIntent().ok} fallback={<Notice tone="bad">{intent.intentError()}</Notice>}>
              <Section title={t().chooseOwnerTitle} summary={t().chooseOwnerDescription} measure>
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
              </Section>
              {/* a notice is a band of its own, across the pane: below the choice it is about, above the deeds */}
              <Show when={intent.identityError()}>
                {(message) => (
                  <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void intent.identityResults.refresh() }]}>
                    {message()}
                  </Notice>
                )}
              </Show>
              {/* only for the chosen mailbox's own senders, as on the v1 page */}
              <Show when={intent.senderUnavailable()}>
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
              </Show>
              <Show when={intent.commandError()}>
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
              </Show>
              <Band>
                <Inline>
                  <Button variant="secondary" href={back()}>
                    {t().cancel}
                  </Button>
                  <Button variant="primary" icon="arrow-right" disabled={blocked()} onClick={() => intent.createDraft()}>
                    {t().continue}
                  </Button>
                </Inline>
              </Band>
            </Show>
          </Show>
        </Show>
      </Pane>
    </Workspace>
  );
}
