import { Composer } from "@k2b/editor/composer";
import type { DateContext } from "@k2b/stdlib";
import { prompts, useLocale } from "@k2b/ui";
import { Button, Icon, Text } from "@k2b/ui/v2";
import { type Accessor, createEffect, createMemo, createSignal, on, Show } from "solid-js";
import type { MailboxController } from "../../mail-workspace";
import MailReplyBox from "../MailReplyBox";
import { deriveReplyIdentityId, deriveReplyRecipients } from "../mail-compose-derivation";
import { createMailConversationNotes } from "../mail-conversation-notes";
import { quoteOriginalOf } from "../mail-quote-original";
import { mailSenderIdentityStatusMessages, senderUnavailableDetail } from "../mail-sender-identity-status";
import type { MailV2Text } from "./mail-v2-messages";

export type MailV2Session = {
  currentUserId: string;
  currentUserEmail: string | null;
  calendarIntegrationAvailable: boolean;
  liveDictation: boolean;
};

/**
 * The reply of the v2 pilot, for one open conversation. At rest it is the composer of the mockup, from @k2b/editor:
 * to whom, from which sender, the start of the text and Send. A click starts Mail's own reply box with its shared
 * draft, which then writes and sends as in v1. The reader places both: the resting composer as it is, the reply box
 * in a `Canvas` of its column, because its drawing is v1's until the composer is rebuilt on v2.
 */
export function createMailV2Reply(props: {
  controller: MailboxController;
  session: MailV2Session;
  dateConfig: DateContext;
  text: () => MailV2Text;
  /** Counts the times a message's Reply asked for the reply; each one starts writing. */
  request: Accessor<number>;
}) {
  const locale = useLocale();
  const c = () => props.controller;
  const data = () => c().data;
  const latest = () => data().detailMessages.at(-1);
  const identities = () => data().identities;
  // A conversation that already has a reply draft opens with it, as in v1.
  const [writing, setWriting] = createSignal(data().conversationDrafts.some((draft) => draft.intent !== "new"));
  createEffect(on(props.request, () => setWriting(true), { defer: true }));
  const start = () => setWriting(true);
  const recipients = createMemo(() => {
    const message = latest();
    if (!message) return [];
    const to = new Set(deriveReplyRecipients(message, "reply", identities()).to.map((address) => address.toLowerCase()));
    return [...message.from, ...message.replyTo]
      .filter((address) => to.has(address.address.toLowerCase()))
      .map((address) => address.name || address.address)
      .filter((name, index, all) => all.indexOf(name) === index);
  });
  const sender = () => {
    const message = latest();
    const id = message ? deriveReplyIdentityId(message, identities()) : null;
    return identities().find((identity) => identity.id === id) ?? identities().find((identity) => identity.isDefault) ?? null;
  };
  const customerName = () => {
    const own = new Set(identities().map((identity) => identity.fromAddress.trim().toLowerCase()));
    for (const message of data().detailMessages) {
      const from = message.from[0];
      if (from && !own.has(from.address.trim().toLowerCase())) return from.name || from.address;
    }
    return null;
  };
  const notes = createMailConversationNotes({
    mailboxId: () => data().mailbox.id,
    conversationId: () => data().selectedConversationId,
    comments: () => data().comments,
    cursor: () => data().commentsCursor,
  });
  const explainSenderUnavailable = async () => {
    const status = mailSenderIdentityStatusMessages.resolve([locale()]).t;
    await prompts.error(`${senderUnavailableDetail(identities(), locale())} ${c().canAdmin() ? "" : status.askAdmin}`.trim(), {
      title: status.cannotSend,
    });
  };
  const toLabel = () => recipients().join(", ");

  return {
    /** The person may answer this conversation: it is open and has a message. */
    shown: () => Boolean(c().canWrite() && data().selectedConversationId && latest()),
    writing,
    label: () => props.text().replyTo({ name: toLabel() }),
    rest: () => (
      <Composer
        label={props.text().replyTo({ name: toLabel() })}
        head={
          <>
            <Icon name="arrow-back-up" tone="muted" />
            <Text type="meta">{props.text().to}</Text>
            <Text>{toLabel()}</Text>
          </>
        }
        headEnd={
          <>
            <Show when={sender()}>
              {(identity) => (
                <Button variant="text" menu onClick={start}>
                  {props.text().from({ name: identity().label })}
                </Button>
              )}
            </Show>
            <Button variant="text" onClick={start}>
              Cc
            </Button>
            <Button variant="text" onClick={start}>
              Bcc
            </Button>
          </>
        }
        placeholder={props.text().writeReply({ name: toLabel() })}
        onStart={start}
        tools={
          <>
            <Button variant="ghost" icon="typography" label={props.text().formatting} onClick={start} />
            <Button variant="ghost" icon="paperclip" label={props.text().attach} onClick={start} />
            <Button variant="ghost" icon="signature" label={props.text().signature} onClick={start} />
            <Button variant="ghost" icon="sparkles" label={props.text().assistant} onClick={start} />
          </>
        }
        actions={
          // Nothing is written yet: Send starts the reply, it never sends an empty one.
          <Button variant="primary" icon="send" onClick={start}>
            {props.text().send}
          </Button>
        }
      />
    ),
    box: () => (
      <MailReplyBox
        mailboxId={data().mailbox.id}
        conversationId={data().selectedConversationId!}
        subject={data().selectedSubject}
        messages={data().detailMessages}
        conversationDrafts={data().conversationDrafts}
        identities={identities()}
        canReplyAll={(() => {
          const message = latest();
          return Boolean(message && deriveReplyRecipients(message, "reply_all", identities()).cc.length > 0);
        })()}
        customerName={customerName()}
        currentUserId={props.session.currentUserId}
        currentUserEmail={props.session.currentUserEmail}
        dateConfig={props.dateConfig}
        canAdmin={c().canAdmin()}
        mailboxRecipientSuggestions={!c().assignedOnly()}
        calendarIntegrationAvailable={props.session.calendarIntegrationAvailable}
        liveDictation={props.session.liveDictation}
        returnHref={c().requestPath()}
        messageSource={(messageId) => {
          const message = data().detailMessages.find((candidate) => candidate.id === messageId);
          // A message whose text has not arrived yet is loaded by the composer, as in the v1 reader.
          return message && message.hydrationStatus === "complete" ? quoteOriginalOf(message, props.dateConfig) : null;
        }}
        createNote={notes.create}
        onReconcile={c().requireWorkspaceReconcile}
        onExplainSenderUnavailable={() => void explainSenderUnavailable()}
        register={() => undefined}
      />
    ),
  };
}

export type MailV2Reply = ReturnType<typeof createMailV2Reply>;
