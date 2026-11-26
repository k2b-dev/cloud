import { openCommand, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { mutation, query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Empty, Failed, Field, Input, Loading, Notice, Section, Select, useToast } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { z } from "zod";
import { apiClient } from "@/api/client";
import { spaceCommandMessages } from "../../../../commands";
import { openDialog } from "../../../lib/open-dialog";
import { readResponseError } from "../../../lib/response";
import { spaceMessages, useSpaceMessages } from "../../messages";

type InvitationContext = Awaited<ReturnType<typeof loadContext>>;

const loadContext = async (spaceId: string, itemId: string, signal?: AbortSignal, locale?: string) => {
  const { t } = spaceMessages.resolve(locale ? [locale] : []);
  const response = await apiClient[":id"].items[":itemId"]["invitation-context"].$get(
    { param: { id: spaceId, itemId } },
    { init: { signal } },
  );
  if (!response.ok) throw new Error(await readResponseError(response, t.invitationOptionsFailed));
  return response.json();
};

const parseAttendees = (value: string, t: ReturnType<typeof useSpaceMessages>) => {
  const email = z.string().trim().email();
  const addresses = new Set(
    value
      .split(/[\s,;]+/u)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  const invalid = [...addresses].find((address) => !email.safeParse(address).success);
  return invalid
    ? { ok: false as const, message: t.invalidEmail({ address: invalid }) }
    : { ok: true as const, attendees: [...addresses].map((address) => ({ name: null, address })) };
};

/**
 * Prepares an invitation or a cancellation as a Mail draft: the mailbox, the sender and the attendees. Nothing is sent
 * here; the draft opens in Mail in a new tab. A failure stays in the dialog with the input.
 */
function InvitationDialog(props: { spaceId: string; itemId: string; title: string; method: "request" | "cancel"; close: () => void }) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const toast = useToast();
  const [mailboxId, setMailboxId] = createSignal<string | null>(null);
  const [senderIdentityId, setSenderIdentityId] = createSignal<string | null>(null);
  const [recipients, setRecipients] = createSignal("");
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  let idempotencyKey = crypto.randomUUID();
  const resetIdempotency = () => {
    idempotencyKey = crypto.randomUUID();
  };

  const contextQuery = query.create<string, InvitationContext>({
    source: () => `${props.spaceId}:${props.itemId}`,
    load: async (_source, { abortSignal }) => loadContext(props.spaceId, props.itemId, abortSignal, locale()),
  });
  const context = contextQuery.data;
  let initializedContext: InvitationContext | null = null;
  createEffect(() => {
    const result = context();
    if (!result || result === initializedContext) return;
    initializedContext = result;
    const mailbox = result.mailboxes[0];
    const identity = mailbox?.identities.find((candidate) => candidate.isDefault) ?? mailbox?.identities[0];
    setMailboxId(mailbox?.id ?? null);
    setSenderIdentityId(identity?.id ?? null);
    setRecipients(result.attendees.map((attendee) => attendee.address).join(", "));
  });

  const selectedMailbox = createMemo(() => context()?.mailboxes.find((mailbox) => mailbox.id === mailboxId()) ?? null);

  const chooseMailbox = (nextMailboxId: string) => {
    resetIdempotency();
    setMailboxId(nextMailboxId);
    const mailbox = context()?.mailboxes.find((candidate) => candidate.id === nextMailboxId);
    const identity = mailbox?.identities.find((candidate) => candidate.isDefault) ?? mailbox?.identities[0];
    setSenderIdentityId(identity?.id ?? null);
  };

  type InvitationIntent = {
    idempotencyKey: string;
    mailboxId: string;
    senderIdentityId: string;
    attendees: Array<{ name: null; address: string }>;
    method: "request" | "cancel";
    mailTab: Window;
  };
  const create = mutation.create<void, InvitationIntent>({
    mutation: async (intent, { abortSignal }) => {
      try {
        const response = await apiClient[":id"].items[":itemId"]["invitation-draft"].$post(
          {
            param: { id: props.spaceId, itemId: props.itemId },
            json: {
              idempotencyKey: intent.idempotencyKey,
              mailboxId: intent.mailboxId,
              senderIdentityId: intent.senderIdentityId,
              attendees: intent.attendees,
              method: intent.method,
            },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readResponseError(response, t.invitationDraftFailed));
        const result = await response.json();
        intent.mailTab.location.replace(new URL(result.href, window.location.origin).href);
        toast(props.method === "cancel" ? t.cancellationOpened : t.invitationOpened, { status: "ok" });
        props.close();
      } catch (error) {
        intent.mailTab.close();
        throw error;
      }
    },
    onError: (error) =>
      setFailure(`${props.method === "cancel" ? t.prepareCancellationFailed : t.prepareInvitationFailed}: ${error.message}`),
  });
  const createInvitation = () => {
    if (create.loading()) return;
    setFailure(null);
    const parsed = parseAttendees(recipients(), t);
    if (!parsed.ok) {
      setValidationError(parsed.message);
      return;
    }
    const selectedMailboxId = mailboxId();
    const selectedSenderIdentityId = senderIdentityId();
    if (!selectedMailboxId || !selectedSenderIdentityId) {
      setValidationError(t.selectVerifiedMailbox);
      return;
    }
    setValidationError(null);
    const mailTab = window.open("about:blank", "_blank");
    if (!mailTab) {
      setFailure(t.mailTabFailed);
      return;
    }
    mailTab.opener = null;
    void create.mutate({
      idempotencyKey,
      mailboxId: selectedMailboxId,
      senderIdentityId: selectedSenderIdentityId,
      attendees: parsed.attendees,
      method: props.method,
      mailTab,
    });
  };

  onCleanup(() => {
    create.abort();
  });

  return (
    <Dialog
      title={props.method === "cancel" ? t.prepareCancellation : t.prepareInvitation}
      open
      onOpenChange={(open) => !open && props.close()}
      foot={
        <>
          <Button onClick={props.close}>{t.cancel}</Button>
          <Button
            variant="primary"
            icon="mail-plus"
            busy={create.loading()}
            disabled={contextQuery.loading() || !context() || !mailboxId() || !senderIdentityId()}
            onClick={createInvitation}
          >
            {t.continueInMail}
          </Button>
        </>
      }
    >
      <Notice tone="note" icon="info-circle" title={t.reviewBeforeSending}>
        {`${props.title} · ${props.method === "cancel" ? t.cancellationReview : t.invitationReview}`}
      </Notice>
      <Show
        when={context()}
        fallback={
          <Show when={contextQuery.error()} fallback={<Loading rows={3} lines={1} />}>
            {(error) => <Failed text={`${t.mailSendersUnavailable}: ${error().message}`} onRetry={() => void contextQuery.refresh()} />}
          </Show>
        }
      >
        {(value) => (
          <Show
            when={value().mailboxes.length > 0}
            fallback={<Empty icon="mail-off" text={`${t.noMailSender}. ${t.noMailSenderDescription}`} />}
          >
            <Field label={t.mailbox} name="mailbox" hint={t.deliveryDescription}>
              <Select
                value={mailboxId() ?? undefined}
                placeholder={t.noWritableMailbox}
                options={value().mailboxes.map((mailbox) => ({ value: mailbox.id, label: mailbox.name }))}
                onChange={chooseMailbox}
              />
            </Field>
            <Field label={t.from} name="sender" hint={t.senderRecipientsDescription}>
              <Select
                value={senderIdentityId() ?? undefined}
                placeholder={t.noVerifiedIdentity}
                options={(selectedMailbox()?.identities ?? []).map((identity) => ({
                  value: identity.id,
                  label: identity.from.name
                    ? `${identity.label} · ${identity.from.name} <${identity.from.address}>`
                    : `${identity.label} · ${identity.from.address}`,
                }))}
                onChange={(value) => {
                  resetIdempotency();
                  setSenderIdentityId(value);
                }}
              />
            </Field>
            <Field label={t.attendees} name="attendees" hint={t.attendeesDescription} error={validationError() ?? undefined}>
              <Input
                multiline
                value={recipients()}
                placeholder="alex@example.com, sam@example.com"
                onInput={(value) => {
                  resetIdempotency();
                  setRecipients(value);
                }}
              />
            </Field>
          </Show>
        )}
      </Show>
      <Show when={failure()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}

export const openEventInvitation = async (
  spaceId: string,
  itemId: string,
  title: string,
  method: "request" | "cancel",
  locale: string,
  signal?: AbortSignal,
) => {
  const context = await loadContext(spaceId, itemId, signal, locale);
  if (signal?.aborted) return;
  if (!context.mailboxes.length || (method === "cancel" && !context.canCancel))
    throw new Error(spaceCommandMessages.resolve([locale]).t.invitationUnavailable);
  await openDialog<void>(locale, (close) => (
    <InvitationDialog spaceId={spaceId} itemId={itemId} title={title} method={method} close={() => close()} />
  ));
};

/** Invitations of an event in its detail: prepare one, or a cancellation once it was sent, as a Mail draft. */
export default function EventInvitations(props: { spaceId: string; itemId: string; title: string }) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const toast = useToast();
  const contextQuery = query.create<string, InvitationContext>({
    source: () => `${props.spaceId}:${props.itemId}`,
    load: async (_source, { abortSignal }) => loadContext(props.spaceId, props.itemId, abortSignal, locale()),
  });
  const context = contextQuery.data;
  const reconcile = () => {
    void contextQuery.invalidate().catch(() => toast(t.invitationStatusRefreshFailed, { status: "bad", retry: reconcile }));
  };
  const openInvitation = async (method: "request" | "cancel", itemId = props.itemId) => {
    try {
      await openCommand("spaces.event.invite", { itemId, method });
      if (itemId === props.itemId) reconcile();
    } catch (error) {
      toast(error instanceof Error ? error.message : t.invitationDraftFailed, { status: "bad" });
    }
  };
  createEffect(() => {
    if (!context()?.mailboxes.length) return;
    const copy = spaceCommandMessages.resolve([locale()]).t;
    const itemId = props.itemId;
    for (const method of ["request", "cancel"] as const) {
      if (method === "cancel" && !context()?.canCancel) continue;
      onCleanup(
        registerContextAwareCommand({
          id: `spaces.${itemId}.invitation.${method}`,
          scope: "selection",
          title: method === "cancel" ? t.prepareCancellation : t.prepareInvitation,
          description:
            method === "cancel" ? copy.cancelDescription({ title: props.title }) : copy.inviteDescription({ title: props.title }),
          icon: method === "cancel" ? "ti ti-calendar-cancel" : "ti ti-calendar-share",
          action: () => openInvitation(method, itemId),
        }),
      );
    }
  });
  return (
    <Section
      icon="send"
      title={t.invitations}
      actions={
        context()?.canCancel
          ? [
              { label: t.prepareInvitation, icon: "calendar-share", onClick: () => void openInvitation("request") },
              { label: t.prepareCancellation, icon: "calendar-cancel", onClick: () => void openInvitation("cancel") },
            ]
          : [{ label: t.prepareInvitation, icon: "calendar-share", onClick: () => void openInvitation("request") }]
      }
    >
      <Show when={contextQuery.error()}>
        {(error) => <Failed text={`${t.invitationStatusUnavailable}: ${error().message}`} onRetry={() => void contextQuery.refresh()} />}
      </Show>
      <Show when={context()?.lastDelivery?.state === "failed"}>
        <Notice tone="bad" icon="alert-circle" title={t.mailDraftFailed}>
          {t.retryInvitation({ detail: context()?.lastDelivery?.errorMessage ?? t.latestMailDraftFailed })}
        </Notice>
      </Show>
    </Section>
  );
}
