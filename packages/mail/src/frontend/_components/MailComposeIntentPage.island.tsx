import { consumeCommandLink, openCommand, registerCommandHandler } from "@k2b/cloud/browser/commands";
import { CommandPathSchema, cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, ButtonLink, NoticeCard, Placeholder, prompts, ScrollArea, Select, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { MailComposeCommandInputSchema, mailCommandMessages } from "../../commands";
import type { MailContactDirectory } from "../../contact-directory-settings";
import type { MailDraftSeed, SenderIdentity } from "../../contracts";
import { readApiError } from "./api-response";
import { readContact } from "./contact-capabilities";
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
  contactDirectory: MailContactDirectory;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const [mailto, setMailto] = createSignal(props.mailto);
  const [returnHref, setReturnHref] = createSignal(CommandPathSchema.safeParse(props.returnHref).success ? props.returnHref : null);
  const [commandLoading, setCommandLoading] = createSignal(false);
  const [commandError, setCommandError] = createSignal<string>();
  const [retryCommand, setRetryCommand] = createSignal<() => Promise<void>>();
  const parsedIntent = createMemo(() => parseMailtoIntent(mailto()));
  const commandAbort = new AbortController();
  onCleanup(() => commandAbort.abort());
  onMount(() => {
    onCleanup(
      registerCommandHandler("mail.compose", MailComposeCommandInputSchema, async (input, options) => {
        if (commandLoading()) throw new Error(t().preparingMessage);
        setRetryCommand(() => () => openCommand("mail.compose", input, options));
        setCommandLoading(true);
        setCommandError(undefined);
        setMailto(null);
        setReturnHref(options.returnTo ?? null);
        try {
          if (input.contact) {
            const copy = mailCommandMessages.resolve([locale()]).t;
            const readTarget = props.contactDirectory.read;
            // Only the configured directory app can read the contact; anything else is unavailable, never guessed.
            if (!readTarget || cloudResourceRefAppId(input.contact) !== readTarget.appId) throw new Error(copy.unavailable);
            const emails = await readContact(readTarget, input.contact.id, commandAbort.signal).then(
              (result) => result.data.emails,
              () => [],
            );
            if (!emails.length) throw new Error(copy.unavailable);
            const selected =
              emails.length === 1
                ? emails[0]
                : (
                    await prompts.search<{ email: string }>(
                      async ({ query }) =>
                        emails
                          .filter((email) => email.email.includes(query))
                          .map((email) => ({ value: email, label: email.email, desc: email.label ?? undefined })),
                      { title: copy.recipient, minQueryLength: 0 },
                    )
                  )?.value;
            if (commandAbort.signal.aborted || !selected) return;
            setMailto(`mailto:${encodeURIComponent(selected.email)}`);
          }
        } catch (error) {
          setCommandError(error instanceof Error ? error.message : mailCommandMessages.resolve([locale()]).t.unavailable);
          // This form owns error feedback and retry; do not add a second global toast.
        } finally {
          setCommandLoading(false);
        }
      }),
    );
    void consumeCommandLink();
  });
  const intentData = () => {
    const parsed = parsedIntent();
    return parsed.ok ? parsed.intent : undefined;
  };
  const intentError = () => {
    const parsed = parsedIntent();
    return !parsed.ok ? intentErrorMessage(parsed.code) : undefined;
  };
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
      const parsed = parsedIntent();
      if (!parsed.ok) throw new Error(intentErrorMessage(parsed.code));
      const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].$post(
        {
          param: { mailboxId: selectedMailboxId },
          json: {
            origin: {
              kind: "compose",
              input: {
                senderIdentityId: identity.id,
                to: parsed.intent.to,
                cc: parsed.intent.cc,
                bcc: parsed.intent.bcc,
                subject: parsed.intent.subject,
                body: parsed.intent.body,
                ...(parsed.intent.body ? { format: "plain" as const } : {}),
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
      const destination = returnHref() ? mailDraftReturnHref(returnHref()!, seed.mailboxId) : fallbackReturnHref;
      window.location.replace(mailDraftSeedHref(seed.mailboxId, seed.id, destination));
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
    if (!selectedMailboxId || !identity || draftCreation.loading() || commandLoading() || commandError()) return;
    draftCreation.mutate({ mailboxId: selectedMailboxId, identity });
  };

  let autoStartAttempted = false;
  createEffect(() => {
    if (
      !props.autoStart ||
      commandLoading() ||
      commandError() ||
      autoStartAttempted ||
      !parsedIntent().ok ||
      identityLoading() ||
      identityError()
    )
      return;
    if (!selectedMailbox() || !selectedIdentity()) return;
    autoStartAttempted = true;
    createDraft();
  });

  const autoStartPending = createMemo(
    () =>
      props.autoStart &&
      parsedIntent().ok &&
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
            when={parsedIntent().ok}
            fallback={
              <NoticeCard tone="danger" icon={false}>
                {intentError()}
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
