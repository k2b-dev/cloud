import type { CloudTheme } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import { Button, ContextMenu, type DropdownAction, type DropdownItem, Placeholder, StatusBadge, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { DraftDerivationKind, DraftIntent, SenderIdentity } from "../../contracts";
import type { MailSecurityFinding } from "../../security-contracts";
import type { MailWorkspaceMessage } from "../../service/workspace";
import MailCalendarInvitation from "./MailCalendarInvitation";
import MailMessageAttachments from "./MailMessageAttachments";
import MailMessageBody from "./MailMessageBody";
import MailMessageDeliveryControl from "./MailMessageDeliveryControl";
import { createMailMessageMenu, MailMessageMenuTrigger } from "./MailSenderMessageActions";
import { deriveReplyRecipients, formatMailAddress, forwardMessageBody } from "./mail-compose-derivation";
import { isOutgoingMessage } from "./mail-conversation-history";
import { mailMessageMessages } from "./mail-message-messages";
import {
  formatMailMessageDateTime,
  type MessageBodyFormat,
  type MessageColors,
  messageDeliveryAllowsResponses,
  messageDeliveryControlLabel,
  messageDeliveryPresentation,
  messagePreviewText,
  resolveMessageBodyFormat,
  resolveMessageColors,
} from "./mail-message-presentation";
import type { MailReadingFormat } from "./mail-user-preferences";

type MailMessageCardContext = {
  mailboxId: string;
  requestUrl: string;
  canWrite: boolean;
  canAdmin: boolean;
  /** False for a person who sees only the conversations assigned to them. */
  mailboxWide: boolean;
  selectionKey: string | null;
  selectedConversationId: string | null;
  totalMessageCount: number;
  identities: SenderIdentity[];
  dateConfig: DateContext;
  readingFormat: MailReadingFormat;
  /** `null` while the browser has not yet resolved Automatic for this island. */
  theme: CloudTheme | null;
  calendarIntegrationAvailable: boolean;
  composerBusy: boolean;
};

type MailMessageCardActions = {
  toggle: (messageId: string) => void;
  selectionChange: (messageId: string, value: string) => void;
  compose: (intent: DraftIntent, message: MailWorkspaceMessage, quotedBody?: string) => void;
  quoteReply: (message: MailWorkspaceMessage, body: HTMLElement) => void;
  derive: (kind: DraftDerivationKind, message: MailWorkspaceMessage) => void | Promise<void>;
  reconcile: () => Promise<void>;
  refresh: () => Promise<void>;
  reassign: (messageId: string) => void | Promise<void>;
  split: (messageId: string) => void | Promise<void>;
};

export default function MailMessageCard(props: {
  message: MailWorkspaceMessage;
  expanded: boolean;
  isLatest: boolean;
  selectionAvailable: boolean;
  context: MailMessageCardContext;
  actions: MailMessageCardActions;
}) {
  // A card shows one message for its whole life. The body clears its selection while it unmounts, when the
  // reader may already have dropped this message, so that report must not read `props.message` again.
  const messageId = props.message.id;
  const locale = useLocale();
  const messages = createMemo(() => mailMessageMessages.resolve([locale()]).t);
  const findingPresentation = (finding: MailSecurityFinding): { title: string; explanation: string } => {
    const t = messages();
    if (finding.code === "admin_deny_policy") {
      return { title: t.blockedByOrganization, explanation: t.blockedByOrganizationExplanation };
    }
    if (finding.code === "authentication_failed") {
      return { title: t.senderVerificationFailed, explanation: t.senderVerificationFailedExplanation };
    }
    if (finding.code === "reply_to_mismatch") {
      return { title: t.repliesAnotherDomain, explanation: t.repliesAnotherDomainExplanation };
    }
    if (finding.code === "misleading_link") {
      return { title: t.unexpectedLink, explanation: t.unexpectedLinkExplanation };
    }
    if (finding.code === "protected_identity_mismatch") {
      return { title: t.senderNameImpersonated, explanation: t.senderNameImpersonatedExplanation };
    }
    return finding;
  };
  let messageBody!: HTMLDivElement;
  const [bodyFormatOverride, setBodyFormatOverride] = createSignal<MessageBodyFormat | null>(null);
  const [colorsOverride, setColorsOverride] = createSignal<MessageColors | null>(null);
  const colors = createMemo(() => resolveMessageColors(props.context.readingFormat, colorsOverride()));
  const [refreshing, setRefreshing] = createSignal(false);
  // Live invalidation replaces the envelope-only snapshot once the body commits;
  // this local action covers paused live updates without a page reload.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await props.actions.refresh();
    } finally {
      setRefreshing(false);
    }
  };
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
    return delivery && messageDeliveryControlLabel(delivery, props.context.canWrite, locale()) ? delivery : null;
  };
  // Cards stay mounted across live updates, so the badge derives from the
  // current delivery state rather than the state the card was mounted with.
  const deliveryBadge = () => {
    const delivery = props.message.delivery;
    return delivery && !controllableDelivery() ? messageDeliveryPresentation(delivery, locale()) : null;
  };
  const outgoing = () => isOutgoingMessage(props.message, props.context.identities);
  const senderLabel = () => {
    if (outgoing()) return messages().you;
    const sender = props.message.from[0];
    return sender?.name || sender?.address || messages().unknownSender;
  };
  const recipientLabel = () =>
    props.message.to.map((address) => address.name || address.address).join(", ") || messages().undisclosedRecipients;
  const routeLabel = () => {
    if (outgoing()) return messages().toRecipient({ recipients: recipientLabel() });
    const ownAddresses = new Set(
      props.context.identities
        .filter((identity) => identity.status === "verified")
        .map((identity) => identity.fromAddress.trim().toLowerCase()),
    );
    return props.message.to.some((recipient) => ownAddresses.has(recipient.address.trim().toLowerCase()))
      ? messages().toMe
      : messages().toRecipient({ recipients: recipientLabel() });
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
      Boolean(props.message.sanitizedHtml),
      Boolean(props.message.plainText?.trim()),
    ),
  );
  const responseActions = (): DropdownItem[] =>
    props.context.canWrite && props.context.selectedConversationId && !exceptionalDelivery()
      ? [
          {
            sectionLabel: messages().respond,
            items: [
              {
                label: messages().reply,
                icon: "ti ti-arrow-back-up",
                action: () => props.actions.compose("reply", props.message),
              },
              ...(canReplyAll()
                ? [
                    {
                      label: messages().replyAll,
                      icon: "ti ti-arrow-back-up-double",
                      action: () => props.actions.compose("reply_all", props.message),
                    },
                  ]
                : []),
              {
                label: messages().forward,
                icon: "ti ti-arrow-forward-up",
                action: () =>
                  props.actions.compose("forward", props.message, forwardMessageBody(props.message, props.context.dateConfig, locale())),
              },
              ...(props.selectionAvailable
                ? [
                    {
                      label: messages().quoteSelection,
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
    const items: DropdownAction[] = [];
    if (props.message.sanitizedHtml && props.message.plainText?.trim() && bodyFormat()) {
      const nextFormat = bodyFormat() === "html" ? "plain" : "html";
      items.push({
        label: nextFormat === "html" ? messages().viewHtml : messages().viewPlain,
        icon: nextFormat === "html" ? "ti ti-code" : "ti ti-align-left",
        action: () => setBodyFormatOverride(nextFormat),
      });
    }
    if (bodyFormat() === "html" && props.context.theme === "dark") {
      const nextColors = colors() === "adapted" ? "original" : "adapted";
      items.push({
        label: nextColors === "original" ? messages().showOriginalColors : messages().adaptColorsToDarkMode,
        icon: nextColors === "original" ? "ti ti-palette" : "ti ti-moon",
        action: () => setColorsOverride(nextColors),
      });
    }
    return items.length > 0 ? [{ sectionLabel: messages().display, items }] : [];
  };
  const messageMenuActions = (): DropdownItem[] => [...responseActions(), ...displayActions()];
  const messageMenu = createMailMessageMenu({
    get mailboxId() {
      return props.context.mailboxId;
    },
    get requestUrl() {
      return props.context.requestUrl;
    },
    get canWrite() {
      return props.context.canWrite;
    },
    get canAdmin() {
      return props.context.canAdmin;
    },
    get mailboxWide() {
      return props.context.mailboxWide;
    },
    get selectionKey() {
      return props.context.selectionKey;
    },
    get selectedConversationId() {
      return props.context.selectedConversationId;
    },
    get message() {
      return props.message;
    },
    get totalMessageCount() {
      return props.context.totalMessageCount;
    },
    get identities() {
      return props.context.identities;
    },
    get primaryActions() {
      return messageMenuActions();
    },
    onReassignMessage: (id) => props.actions.reassign(id),
    onSplitMessage: (id) => props.actions.split(id),
    onDeriveMessage: (kind, message) => props.actions.derive(kind, message),
  });
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
      {/* A right-click on the message opens its "…" menu. A block host takes focus back when Escape closes it. */}
      <ContextMenu class="block" tabIndex={-1} items={messageMenu.items()} label={messageMenu.label()} keepNativeMenu>
        <div
          class={`flex items-start gap-1 rounded-[var(--ui-radius-surface)] p-1 transition-colors ${
            props.isLatest ? "" : "bg-[var(--ui-surface-subtle)] hover:bg-[var(--ui-hover)] focus-within:bg-[var(--ui-hover)]"
          }`}
        >
          <button
            type="button"
            class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-[var(--ui-radius-control)] p-2 text-left"
            aria-expanded={props.expanded}
            data-mail-message-header
            onClick={() => props.actions.toggle(props.message.id)}
          >
            <span class="min-w-0 flex-1">
              <span class="flex h-6 min-w-0 items-center gap-2">
                <span
                  class="inline-flex h-5 w-5 shrink-0 items-center justify-center text-secondary"
                  title={outgoing() ? messages().outgoingMessage : messages().incomingMessage}
                >
                  <i class={`ti ${outgoing() ? "ti-arrow-up-right" : "ti-arrow-down-left"} text-sm`} aria-hidden="true" />
                  <span class="sr-only">{outgoing() ? messages().outgoingMessage : messages().incomingMessage}</span>
                </span>
                <span
                  class={`truncate text-sm font-semibold ${props.expanded || props.isLatest ? "text-primary" : "text-secondary"}`}
                  title={props.message.from.map(formatMailAddress).join(", ") || messages().unknownSender}
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
              <Show when={deliveryBadge()}>
                {(status) => (
                  <StatusBadge
                    tone={status().tone}
                    label={status().label}
                    icon={status().icon}
                    title={props.message.delivery?.lastErrorMessage ?? undefined}
                    class="mt-1"
                  />
                )}
              </Show>
            </span>
            <span class="flex h-6 shrink-0 items-center gap-2">
              <time class="shrink-0 text-xs text-dimmed" dateTime={props.message.internalDate}>
                {formatMailMessageDateTime(props.message.internalDate, props.context.dateConfig)}
              </time>
              <i class={`ti ${props.expanded ? "ti-chevron-up" : "ti-chevron-down"} text-dimmed print:hidden`} aria-hidden="true" />
            </span>
          </button>
          <div class="flex h-10 shrink-0 items-center">
            <MailMessageMenuTrigger menu={messageMenu} />
          </div>
        </div>
        <Show when={props.message.deletedOnServer}>
          {/* Full width and wrapping, so the notice stays readable on a phone; the hint explains it on hover. */}
          <p
            class="flex items-start gap-1.5 px-3 pb-1 text-xs text-secondary"
            title={messages().deletedOnServerHint}
            data-mail-deleted-on-server
          >
            <i class="ti ti-lock mt-0.5 shrink-0" aria-hidden="true" />
            <span>{messages().deletedOnServer}</span>
          </p>
        </Show>
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
                    {security().verdict === "quarantined" ? messages().blockedInReader : messages().checkCarefully}
                  </p>
                  <ul class="mt-1 list-disc space-y-0.5 pl-4 text-current/80">
                    {security().findings.map((finding) => {
                      const presentation = findingPresentation(finding);
                      return <li title={presentation.explanation}>{presentation.title}</li>;
                    })}
                  </ul>
                  <Show when={security().linksDisabled}>
                    <p class="mt-1 text-current/80">{messages().linksDisabled}</p>
                  </Show>
                  <a class="mt-1 inline-block font-medium underline underline-offset-2" href="/app/mail/help/mail-security">
                    {messages().securityHelp}
                  </a>
                </div>
              </div>
            </Show>
            <div ref={messageBody} class="mail-message-body min-w-0 overflow-x-auto text-sm text-primary">
              <Show
                when={bodyFormat()}
                keyed
                fallback={
                  props.message.hydrationStatus === "body" || props.message.hydrationStatus === "complete" ? (
                    <Placeholder state="empty" variant="compact" title={messages().noBody} />
                  ) : props.message.hydrationStatus === "failed" ? (
                    <Placeholder state="error" variant="compact" title={messages().bodySyncFailed} />
                  ) : (
                    <Placeholder
                      state="loading"
                      title={messages().bodySyncing}
                      action={
                        <Button variant="secondary" size="sm" loading={refreshing()} onClick={() => void refresh()}>
                          {messages().refreshMessage}
                        </Button>
                      }
                    />
                  )
                }
              >
                {(format) => (
                  <div class="contents" data-mail-body-format={format}>
                    <MailMessageBody
                      mailboxId={props.context.mailboxId}
                      messageId={props.message.id}
                      format={format}
                      theme={props.context.theme}
                      colors={colors()}
                      html={props.message.sanitizedHtml}
                      plainText={props.message.plainText}
                      attachments={props.message.attachments}
                      remoteContent={props.message.remoteContent}
                      linksDisabled={security().linksDisabled}
                      onSelectionChange={(value) => props.actions.selectionChange(messageId, value)}
                    />
                  </div>
                )}
              </Show>
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
      </ContextMenu>
    </article>
  );
}
