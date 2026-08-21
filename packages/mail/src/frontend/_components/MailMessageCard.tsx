import type { DateContext } from "@k2b/stdlib";
import { type DropdownItem, Placeholder, StatusBadge } from "@k2b/ui";
import type { CloudTheme } from "@valentinkolb/cloud/shared";
import { createMemo, createSignal, Show } from "solid-js";
import type { DraftDerivationKind, DraftIntent, SenderIdentity } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import MailCalendarInvitation from "./MailCalendarInvitation";
import MailMessageAttachments from "./MailMessageAttachments";
import MailMessageBody from "./MailMessageBody";
import MailMessageDeliveryControl from "./MailMessageDeliveryControl";
import MailSenderMessageActions from "./MailSenderMessageActions";
import { deriveReplyRecipients, formatMailAddress, forwardMessageBody } from "./mail-compose-derivation";
import { isOutgoingMessage } from "./mail-conversation-history";
import {
  formatMailMessageDateTime,
  type MessageBodyFormat,
  messageDeliveryAllowsResponses,
  messageDeliveryControlLabel,
  messageDeliveryPresentation,
  messagePreviewText,
  resolveMessageBodyFormat,
} from "./mail-message-presentation";
import type { MailReadingFormat } from "./mail-user-preferences";

type MailMessageCardContext = {
  mailboxId: string;
  requestUrl: string;
  canWrite: boolean;
  canAdmin: boolean;
  selectionKey: string | null;
  selectedConversationId: string | null;
  totalMessageCount: number;
  identities: SenderIdentity[];
  dateConfig: DateContext;
  readingFormat: MailReadingFormat;
  theme: CloudTheme;
  calendarIntegrationAvailable: boolean;
  composerBusy: boolean;
};

type MailMessageCardActions = {
  toggle: (messageId: string) => void;
  selectionChange: (messageId: string, value: string) => void;
  compose: (intent: DraftIntent, message: MessageDetail, quotedBody?: string) => void;
  quoteReply: (message: MessageDetail, body: HTMLElement) => void;
  derive: (kind: DraftDerivationKind, message: MessageDetail) => void | Promise<void>;
  reconcile: () => Promise<void>;
  reassign: (messageId: string) => void | Promise<void>;
  split: (messageId: string) => void | Promise<void>;
};

export default function MailMessageCard(props: {
  message: MessageDetail;
  expanded: boolean;
  isLatest: boolean;
  selectionAvailable: boolean;
  context: MailMessageCardContext;
  actions: MailMessageCardActions;
}) {
  let messageBody!: HTMLDivElement;
  const [bodyFormatOverride, setBodyFormatOverride] = createSignal<MessageBodyFormat | null>(null);
  const security = () =>
    props.message.security ?? {
      risk: "none" as const,
      verdict: "clear" as const,
      findings: [],
      linksDisabled: false,
      evaluatedAt: new Date(0).toISOString(),
    };
  const controllableDelivery = () => {
    const delivery = props.message.delivery;
    return delivery && messageDeliveryControlLabel(delivery, props.context.canWrite) ? delivery : null;
  };
  const outgoing = () => isOutgoingMessage(props.message, props.context.identities);
  const senderLabel = () => {
    if (outgoing()) return "You";
    const sender = props.message.from[0];
    return sender?.name || sender?.address || "Unknown sender";
  };
  const recipientLabel = () => props.message.to.map((address) => address.name || address.address).join(", ") || "undisclosed recipients";
  const routeLabel = () => {
    if (outgoing()) return `to ${recipientLabel()}`;
    const ownAddresses = new Set(
      props.context.identities
        .filter((identity) => identity.status === "verified")
        .map((identity) => identity.fromAddress.trim().toLowerCase()),
    );
    return props.message.to.some((recipient) => ownAddresses.has(recipient.address.trim().toLowerCase()))
      ? "to me"
      : `to ${recipientLabel()}`;
  };
  const preview = () => messagePreviewText(props.message.plainText, props.message.forwardText);
  const exceptionalDelivery = () => {
    const delivery = props.message.delivery;
    return delivery ? !messageDeliveryAllowsResponses(delivery.state) : false;
  };
  const canReplyAll = () => deriveReplyRecipients(props.message, "reply_all", props.context.identities).cc.length > 0;
  const bodyFormat = createMemo(() =>
    resolveMessageBodyFormat(
      props.context.readingFormat,
      bodyFormatOverride(),
      props.context.theme,
      Boolean(props.message.sanitizedHtml),
      Boolean(props.message.plainText),
    ),
  );
  const responseActions = (): DropdownItem[] =>
    props.context.canWrite && props.context.selectedConversationId && !exceptionalDelivery()
      ? [
          {
            sectionLabel: "Respond",
            items: [
              {
                label: "Reply",
                icon: "ti ti-arrow-back-up",
                action: () => props.actions.compose("reply", props.message),
              },
              ...(canReplyAll()
                ? [
                    {
                      label: "Reply all",
                      icon: "ti ti-arrow-back-up-double",
                      action: () => props.actions.compose("reply_all", props.message),
                    },
                  ]
                : []),
              {
                label: "Forward",
                icon: "ti ti-arrow-forward-up",
                action: () => props.actions.compose("forward", props.message, forwardMessageBody(props.message, props.context.dateConfig)),
              },
              ...(props.selectionAvailable
                ? [
                    {
                      label: "Quote selection",
                      icon: "ti ti-blockquote",
                      action: () => props.actions.quoteReply(props.message, messageBody),
                    },
                  ]
                : []),
            ],
          },
        ]
      : [];
  const displayActions = (): DropdownItem[] => {
    if (!props.message.sanitizedHtml || !props.message.plainText || !bodyFormat()) return [];
    const nextFormat = bodyFormat() === "html" ? "plain" : "html";
    return [
      {
        sectionLabel: "Display",
        items: [
          {
            label: nextFormat === "html" ? "View as HTML" : "View as plain text",
            icon: nextFormat === "html" ? "ti ti-code" : "ti ti-align-left",
            action: () => setBodyFormatOverride(nextFormat),
          },
        ],
      },
    ];
  };
  const messageMenuActions = (): DropdownItem[] => [...responseActions(), ...displayActions()];
  const hasCalendarInvitation = () =>
    props.message.attachments.some(
      (attachment) =>
        attachment.contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/calendar" ||
        attachment.filename?.toLowerCase().endsWith(".ics"),
    );

  return (
    <article
      class="group min-w-0 scroll-mt-3 py-1"
      data-mail-message-id={props.message.id}
      data-mail-direction={outgoing() ? "outgoing" : "incoming"}
      style={`view-transition-name: mail-message-${props.message.id}`}
    >
      <div
        class={`flex items-start gap-1 rounded-[var(--ui-radius-surface)] p-1 transition-colors ${
          props.isLatest ? "" : "bg-[var(--ui-surface-subtle)] hover:bg-[var(--ui-hover)] focus-within:bg-[var(--ui-hover)]"
        }`}
      >
        <button
          type="button"
          class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-[var(--ui-radius-control)] p-2 text-left"
          aria-expanded={props.expanded}
          onClick={() => props.actions.toggle(props.message.id)}
        >
          <span class="min-w-0 flex-1">
            <span class="flex h-6 min-w-0 items-center gap-2">
              <span
                class="inline-flex h-5 w-5 shrink-0 items-center justify-center text-secondary"
                title={outgoing() ? "Outgoing message" : "Incoming message"}
              >
                <i class={`ti ${outgoing() ? "ti-arrow-up-right" : "ti-arrow-down-left"} text-sm`} aria-hidden="true" />
                <span class="sr-only">{outgoing() ? "Outgoing message" : "Incoming message"}</span>
              </span>
              <span
                class={`truncate text-sm font-semibold ${props.expanded || props.isLatest ? "text-primary" : "text-secondary"}`}
                title={props.message.from.map(formatMailAddress).join(", ") || "Unknown sender"}
              >
                {senderLabel()}
              </span>
              <span class="truncate text-xs text-dimmed">{routeLabel()}</span>
            </span>
            <Show when={!props.expanded && preview()}>
              {(value) => (
                <span class="mt-1 block truncate text-xs leading-5 text-dimmed" data-mail-message-preview>
                  {value()}
                </span>
              )}
            </Show>
            <Show when={props.message.delivery}>
              {(delivery) => {
                if (messageDeliveryControlLabel(delivery(), props.context.canWrite)) return null;
                const status = messageDeliveryPresentation(delivery());
                return status ? (
                  <StatusBadge
                    tone={status.tone}
                    label={status.label}
                    icon={status.icon}
                    title={delivery().lastErrorMessage ?? undefined}
                    class="mt-1"
                  />
                ) : null;
              }}
            </Show>
          </span>
          <span class="flex h-6 shrink-0 items-center gap-2">
            <time class="shrink-0 text-xs text-dimmed" dateTime={props.message.internalDate}>
              {formatMailMessageDateTime(props.message.internalDate, props.context.dateConfig)}
            </time>
            <i class={`ti ${props.expanded ? "ti-chevron-up" : "ti-chevron-down"} text-dimmed`} aria-hidden="true" />
          </span>
        </button>
        <div class="flex h-10 shrink-0 items-center">
          <MailSenderMessageActions
            mailboxId={props.context.mailboxId}
            requestUrl={props.context.requestUrl}
            canWrite={props.context.canWrite}
            canAdmin={props.context.canAdmin}
            selectionKey={props.context.selectionKey}
            selectedConversationId={props.context.selectedConversationId}
            message={props.message}
            totalMessageCount={props.context.totalMessageCount}
            identities={props.context.identities}
            primaryActions={messageMenuActions()}
            onReassignMessage={props.actions.reassign}
            onSplitMessage={props.actions.split}
            onDeriveMessage={props.actions.derive}
          />
        </div>
      </div>
      <Show when={controllableDelivery()}>
        {(delivery) => (
          <MailMessageDeliveryControl
            mailboxId={props.context.mailboxId}
            requestUrl={props.context.requestUrl}
            delivery={delivery()}
            canWrite={props.context.canWrite}
            dateConfig={props.context.dateConfig}
            onReconcile={props.actions.reconcile}
          />
        )}
      </Show>
      <Show when={props.expanded}>
        <div class="px-3 pb-3 pt-2">
          <Show when={security().risk !== "none"}>
            <div
              class={`mb-3 flex gap-2 rounded-[var(--ui-radius-control)] border px-3 py-2 text-xs ${
                security().risk === "danger"
                  ? "border-red-300/70 bg-red-50/70 text-red-950 dark:border-red-900 dark:bg-red-950/25 dark:text-red-100"
                  : "border-amber-300/70 bg-amber-50/70 text-amber-950 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-100"
              }`}
              role="status"
            >
              <i
                class={`ti ${security().risk === "danger" ? "ti-shield-x" : "ti-shield-exclamation"} mt-0.5 shrink-0`}
                aria-hidden="true"
              />
              <div class="min-w-0">
                <p class="font-semibold">
                  {security().verdict === "quarantined" ? "Blocked in the Mail reader" : "Check this message carefully"}
                </p>
                <ul class="mt-1 list-disc space-y-0.5 pl-4 text-current/80">
                  {security().findings.map((finding) => (
                    <li title={finding.explanation}>{finding.title}</li>
                  ))}
                </ul>
                <Show when={security().linksDisabled}>
                  <p class="mt-1 text-current/80">Links and attachments are disabled here. An administrator can review the rule.</p>
                </Show>
                <a class="mt-1 inline-block font-medium underline underline-offset-2" href="/app/mail/help/mail-security">
                  How Mail protects you
                </a>
              </div>
            </div>
          </Show>
          <div ref={messageBody} class="mail-message-body min-w-0 overflow-x-auto text-sm text-primary">
            {props.message.sanitizedHtml || props.message.plainText ? (
              <Show keyed when={bodyFormat()}>
                {(format) => (
                  <MailMessageBody
                    mailboxId={props.context.mailboxId}
                    messageId={props.message.id}
                    format={format}
                    html={props.message.sanitizedHtml}
                    plainText={props.message.plainText}
                    attachments={props.message.attachments}
                    remoteContent={props.message.remoteContent}
                    linksDisabled={security().linksDisabled}
                    onSelectionChange={(value) => props.actions.selectionChange(props.message.id, value)}
                  />
                )}
              </Show>
            ) : props.message.hydrationStatus === "body" || props.message.hydrationStatus === "complete" ? (
              <Placeholder state="empty" variant="compact" title="This message has no body" />
            ) : props.message.hydrationStatus === "failed" ? (
              <Placeholder state="error" variant="compact" title="The message body could not be synchronized" />
            ) : (
              <Placeholder state="loading" title="Body is still synchronizing" />
            )}
          </div>
          <Show when={hasCalendarInvitation() && props.context.calendarIntegrationAvailable && !security().linksDisabled}>
            <MailCalendarInvitation
              mailboxId={props.context.mailboxId}
              messageId={props.message.id}
              requestUrl={props.context.requestUrl}
              canWrite={props.context.canWrite}
              dateConfig={props.context.dateConfig}
            />
          </Show>
          <Show when={props.message.attachments.length > 0 && !security().linksDisabled}>
            <MailMessageAttachments
              mailboxId={props.context.mailboxId}
              messageId={props.message.id}
              attachments={props.message.attachments}
              canShare={props.context.canAdmin}
            />
          </Show>
        </div>
      </Show>
    </article>
  );
}
