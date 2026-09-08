import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, NoticeCard, Placeholder, prompts, ScrollArea, Select, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailDraftSeed, SenderIdentity } from "../../contracts";
import { readApiError } from "./api-response";
import { type MailComposeIntentErrorCode, parseMailtoIntent } from "./mail-compose-intent";
import { mailDraftReturnHref, mailDraftSeedHref } from "./mail-compose-route";
import { mailComposerMessages } from "./mail-composer-messages";
import { storeMailDraftSeed } from "./mail-draft-seed-store";
import { readMailSenderPreference, selectComposeSenderIdentity, writeMailSenderPreference } from "./mail-sender-preference";

type WritableMailbox = {
  id: string;
  name: string;
  description: string | null;
};

export default function MailComposeIntentPage(props: {
  mailboxes: WritableMailbox[];
  initialMailboxId: string;
  autoStart: boolean;
  mailto: string | null;
  returnHref: string | null;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const parsedIntent = parseMailtoIntent(props.mailto);
  const intentErrorMessage = (code: MailComposeIntentErrorCode): string => {
    switch (code) {
      case "too_large":
        return t().emailLinkTooLarge;
      case "invalid_link":
        return t().emailLinkInvalid;
      case "invalid_encoding":
        return t().emailLinkInvalidEncoding;
      case "duplicate_field":
        return t().emailLinkDuplicateField;
      case "subject_too_long":
        return t().emailLinkSubjectTooLong;
      case "body_too_long":
        return t().emailLinkBodyTooLong;
      case "too_many_to":
        return t().emailLinkTooManyTo;
      case "too_many_cc":
        return t().emailLinkTooManyCc;
      case "too_many_bcc":
        return t().emailLinkTooManyBcc;
      case "invalid_to":
        return t().emailLinkInvalidTo;
      case "invalid_cc":
        return t().emailLinkInvalidCc;
      case "invalid_bcc":
        return t().emailLinkInvalidBcc;
    }
  };
  const [mailboxId, setMailboxId] = createSignal(props.initialMailboxId);
  const [identityId, setIdentityId] = createSignal("");
  const [autoStartFailed, setAutoStartFailed] = createSignal(false);
  const identityResults = query.create<string, { mailboxId: string; items: SenderIdentity[] }>({
    source: mailboxId,
    enabled: () => Boolean(mailboxId()),
    load: async (selectedMailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"].$get(
        { param: { mailboxId: selectedMailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().identitiesLoadFailed));
      return { mailboxId: selectedMailboxId, items: (await response.json()).filter((identity) => identity.status === "verified") };
    },
  });
  const identities = () => {
    const result = identityResults.data();
    return result?.mailboxId === mailboxId() ? result.items : [];
  };
  const identityLoading = () => identityResults.loading() || identityResults.refreshing();
  const identityError = () => identityResults.error()?.message ?? null;

  createEffect(() => {
    const selectedMailboxId = mailboxId();
    setIdentityId("");
    const result = identityResults.data();
    if (!selectedMailboxId || result?.mailboxId !== selectedMailboxId) return;
    const preferredIdentityId = readMailSenderPreference(localStorage, selectedMailboxId);
    const selected = selectComposeSenderIdentity(result.items, preferredIdentityId, props.autoStart);
    setIdentityId(selected?.id ?? "");
  });

  const selectedMailbox = createMemo(() => props.mailboxes.find((mailbox) => mailbox.id === mailboxId()) ?? null);
  const selectedIdentity = createMemo(() => identities().find((identity) => identity.id === identityId()) ?? null);
  const draftCreation = mutations.create<{ seed: MailDraftSeed; identityId: string }, { mailboxId: string; identity: SenderIdentity }>({
    mutation: async ({ mailboxId: selectedMailboxId, identity }, { abortSignal }) => {
      if (!parsedIntent.ok) throw new Error(intentErrorMessage(parsedIntent.code));
      const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post(
        {
          param: { mailboxId: selectedMailboxId },
          json: {
            origin: {
              kind: "compose",
              input: {
                senderIdentityId: identity.id,
                to: parsedIntent.intent.to,
                cc: parsedIntent.intent.cc,
                bcc: parsedIntent.intent.bcc,
                subject: parsedIntent.intent.subject,
                body: parsedIntent.intent.body,
                ...(parsedIntent.intent.body ? { format: "plain" as const } : {}),
                intent: "new",
                conversationId: null,
                sourceMessageId: null,
                includeSourceAttachments: false,
              },
            },
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().draftCreateFailed));
      return { seed: await response.json(), identityId: identity.id };
    },
    onSuccess: ({ seed, identityId }) => {
      writeMailSenderPreference(localStorage, seed.mailboxId, identityId);
      try {
        storeMailDraftSeed(localStorage, seed);
      } catch {
        void prompts.error(t().localMessageFailed, {
          title: t().startMessageFailed,
        });
        return;
      }
      const fallbackReturnHref = `/app/mail/${seed.mailboxId}`;
      const returnHref = props.returnHref ? mailDraftReturnHref(props.returnHref, seed.mailboxId) : fallbackReturnHref;
      window.location.replace(mailDraftSeedHref(seed.mailboxId, seed.id, returnHref));
    },
    onError: (error) => {
      setAutoStartFailed(true);
      return prompts.error(error.message, { title: t().startMessageFailed });
    },
  });

  onCleanup(() => {
    draftCreation.abort();
  });

  const createDraft = () => {
    const selectedMailboxId = mailboxId();
    const identity = selectedIdentity();
    if (!selectedMailboxId || !identity || draftCreation.loading()) return;
    draftCreation.mutate({ mailboxId: selectedMailboxId, identity });
  };

  let autoStartAttempted = false;
  createEffect(() => {
    if (!props.autoStart || autoStartAttempted || !parsedIntent.ok || identityLoading() || identityError()) return;
    if (!selectedMailbox() || !selectedIdentity()) return;
    autoStartAttempted = true;
    createDraft();
  });

  const autoStartPending = createMemo(
    () =>
      props.autoStart &&
      parsedIntent.ok &&
      Boolean(selectedMailbox()) &&
      !autoStartFailed() &&
      !identityError() &&
      (identityLoading() || draftCreation.loading() || Boolean(selectedIdentity())),
  );

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
          <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-selected)] text-accent">
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
          <Show
            when={parsedIntent.ok}
            fallback={
              <NoticeCard tone="danger" icon={false}>
                {!parsedIntent.ok && intentErrorMessage(parsedIntent.code)}
              </NoticeCard>
            }
          >
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
                  <NoticeCard tone="danger" icon={false} bodyClass="flex items-center justify-between gap-3" role="alert">
                    <span>{message()}</span>
                    <Button variant="secondary" size="sm" type="button" onClick={() => void identityResults.refresh()}>
                      {t().retry}
                    </Button>
                  </NoticeCard>
                )}
              </Show>
              <Show when={mailboxId() && !identityLoading() && !identityError() && identities().length === 0}>
                <NoticeCard tone="neutral" icon={false}>
                  {t().noVerifiedSender}
                </NoticeCard>
              </Show>
            </div>
            <Show when={props.mailto}>
              <div class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 text-sm">
                <p class="font-medium text-primary">{t().emailLink}</p>
                <p class="mt-1 truncate text-secondary">
                  {parsedIntent.ok && parsedIntent.intent.to.length > 0
                    ? t().toAddresses({ value: parsedIntent.intent.to.map((recipient) => recipient.address).join(", ") })
                    : t().noRecipientSupplied}
                </p>
                <Show when={parsedIntent.ok && parsedIntent.intent.subject}>
                  <p class="truncate text-secondary">{parsedIntent.ok && parsedIntent.intent.subject}</p>
                </Show>
              </div>
            </Show>
            <div class="flex items-center justify-between gap-3">
              <ButtonLink variant="secondary" size="sm" href={selectedMailbox() ? `/app/mail/${selectedMailbox()!.id}` : "/app/mail"}>
                {t().cancel}
              </ButtonLink>
              <Button
                size="sm"
                type="button"
                disabled={!selectedMailbox() || !selectedIdentity() || identityLoading() || draftCreation.loading()}
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
