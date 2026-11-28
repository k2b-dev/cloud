import { Button, ButtonLink, NoticeCard, Placeholder, ScrollArea, Select } from "@k2b/ui";
import { Show } from "solid-js";
import MailSenderUnavailableNotice from "./MailSenderUnavailableNotice";
import { createMailComposeIntent, type MailComposeIntentProps } from "./mail-compose-intent-state";

export default function MailComposeIntentPage(props: MailComposeIntentProps) {
  const {
    t,
    mailto,
    returnHref,
    commandLoading,
    commandError,
    retryCommand,
    parsedIntent,
    intentData,
    intentError,
    mailboxId,
    setMailboxId,
    identityId,
    setIdentityId,
    identities,
    allIdentities,
    identityLoading,
    identityError,
    identityResults,
    senderUnavailable,
    selectedMailbox,
    settingsOpening,
    openSenderSettings,
    selectedIdentity,
    draftCreation,
    createDraft,
    autoStartPending,
  } = createMailComposeIntent(props);
  return (
    <ScrollArea class="relative flex h-full min-h-0 items-start justify-center p-3 sm:p-6">
      <Show when={autoStartPending()}>
        <Placeholder state="loading" variant="panel" class="absolute inset-0" title={t().preparingMessage} />
      </Show>
      <section
        class="paper mt-[8vh] flex w-full max-w-xl flex-col gap-4 p-4 sm:p-6"
        classList={{ hidden: autoStartPending() }}
        aria-labelledby="mail-compose-intent-title"
      >
        <div class="flex items-start gap-3">
          <span class="k2b-icon-tile app-accent-text h-10 w-10">
            <i class="ti ti-pencil" aria-hidden="true" />
          </span>
          <div class="min-w-0">
            <h1 id="mail-compose-intent-title" class="text-lg font-semibold text-primary">
              {t().newMessage}
            </h1>
            <p class="text-sm text-secondary">{t().chooseOwnerDescription}</p>
          </div>
        </div>

        <Show
          when={props.mailboxes.length > 0}
          fallback={<Placeholder state="empty" title={t().noWritableMailbox} description={t().noWritableMailboxDescription} />}
        >
          <Show when={parsedIntent().ok} fallback={<NoticeCard tone="danger">{intentError()}</NoticeCard>}>
            <div class="flex flex-col gap-3">
              <Select
                label={t().mailbox}
                placeholder={t().chooseMailbox}
                value={mailboxId}
                onValueChange={setMailboxId}
                options={props.mailboxes.map((mailbox) => ({
                  id: mailbox.id,
                  label: mailbox.name,
                  description: mailbox.description ?? undefined,
                }))}
                disabled={draftCreation.loading()}
              />
              <Select
                label={t().from}
                placeholder={identityLoading() ? t().loadingSenders : t().chooseSender}
                value={identityId}
                onValueChange={setIdentityId}
                options={identities().map((identity) => ({
                  id: identity.id,
                  label: identity.label,
                  description: `${identity.displayName ? `${identity.displayName} · ` : ""}${identity.fromAddress}`,
                }))}
                disabled={!mailboxId() || identityLoading() || draftCreation.loading()}
              />
              <Show when={identityError()}>
                {(message) => (
                  <NoticeCard tone="danger" bodyClass="flex items-center justify-between gap-3" role="alert">
                    <span>{message()}</span>
                    <Button variant="secondary" size="sm" type="button" onClick={() => void identityResults.refresh()}>
                      {t().retry}
                    </Button>
                  </NoticeCard>
                )}
              </Show>
              {/* Shown only for the selected mailbox's own senders: a refresh after the sender settings keeps it in place, a
                  switch to another mailbox hides it until that mailbox's senders arrive. */}
              <Show when={senderUnavailable()}>
                <MailSenderUnavailableNotice
                  identities={allIdentities()}
                  onOpenSettings={selectedMailbox()?.canManage ? () => void openSenderSettings() : undefined}
                  opening={settingsOpening()}
                />
              </Show>
            </div>
            <Show when={commandError()}>
              {(error) => (
                <NoticeCard tone="danger" role="alert" bodyClass="flex items-center justify-between gap-3">
                  <span>{error()}</span>
                  <Button variant="secondary" size="sm" disabled={commandLoading()} onClick={() => void retryCommand()?.().catch(() => {})}>
                    {t().retry}
                  </Button>
                </NoticeCard>
              )}
            </Show>
            <Show when={mailto()}>
              <div class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 text-sm">
                <p class="font-medium text-primary">{t().emailLink}</p>
                <p class="mt-1 truncate text-secondary">
                  {Boolean(intentData()?.to.length)
                    ? t().toAddresses({
                        value: intentData()!
                          .to.map((recipient) => recipient.address)
                          .join(", "),
                      })
                    : t().noRecipientSupplied}
                </p>
                <Show when={intentData()?.subject}>
                  <p class="truncate text-secondary">{intentData()?.subject}</p>
                </Show>
              </div>
            </Show>
            <div class="flex items-center justify-between gap-3">
              <ButtonLink
                variant="secondary"
                size="sm"
                href={returnHref() ?? (selectedMailbox() ? `/app/mail/${selectedMailbox()!.id}` : "/app/mail")}
              >
                {t().cancel}
              </ButtonLink>
              <Button
                size="sm"
                type="button"
                disabled={
                  !selectedMailbox() ||
                  !selectedIdentity() ||
                  identityLoading() ||
                  draftCreation.loading() ||
                  commandLoading() ||
                  Boolean(commandError())
                }
                onClick={createDraft}
              >
                <i class={`ti ${draftCreation.loading() ? "ti-loader-2 animate-spin" : "ti-arrow-right"}`} aria-hidden="true" />
                {t().continue}
              </Button>
            </div>
          </Show>
        </Show>
      </section>
    </ScrollArea>
  );
}
