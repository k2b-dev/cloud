import { importOnDemand } from "@k2b/cloud/browser/reload";
import { mutation } from "@k2b/stdlib/solid";
import { Dropdown, type DropdownItem, prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { DraftDerivationKind, MailAutomationConditions, SenderIdentity, SenderMatchKind } from "../../contracts";
import type { MailWorkspaceMessage } from "../../service/workspace";
import { readApiError } from "./api-response";
import type { AutomationActionKind } from "./mail-automation-actions";
import { useMailCloudId } from "./mail-cloud-id";
import { isOutgoingMessage } from "./mail-conversation-history";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { mailReaderMessages } from "./mail-reader-messages";
import { resolveMailMessageActionVisibility } from "./mail-message-action-visibility";
import { buildExactSenderSearchHref, buildMailingListHref, mailRouteUrl, senderDomainFromAddress } from "./mail-navigation";

type SelectionContext = {
  selectionKey: string | null;
};

export type MailMessageMenuProps = {
  mailboxId: string;
  requestUrl: string;
  canWrite: boolean;
  canAdmin: boolean;
  mailboxWide: boolean;
  selectionKey: string | null;
  selectedConversationId: string | null;
  message: MailWorkspaceMessage;
  totalMessageCount: number;
  identities: SenderIdentity[];
  primaryActions?: DropdownItem[];
  /** Every message of the conversation, so Technical details can step from one to the next. */
  conversationMessages?: MailWorkspaceMessage[];
  onReassignMessage: (messageId: string) => void | Promise<void>;
  onSplitMessage: (messageId: string) => void | Promise<void>;
  onDeriveMessage: (kind: DraftDerivationKind, message: MailWorkspaceMessage) => unknown;
};

export type MailMessageMenu = ReturnType<typeof createMailMessageMenu>;

/** One thing to do about a message's sender, for the sender card. */
export type SenderAction = {
  id: "find" | "automation" | "block" | "block-domain" | "unsubscribe";
  label: string;
  icon: string;
  href?: string;
  action?: () => void;
};

/** The items of a message's "…" menu, which a right-click on the message opens as well. */
export function createMailMessageMenu(props: MailMessageMenuProps) {
  const locale = useLocale();
  const cloudId = useMailCloudId();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const [automationLoading, setAutomationLoading] = createSignal(false);
  const openIncomingAutomation = async (
    address: string,
    options: { matchKind?: SenderMatchKind; action?: AutomationActionKind; name?: string } = {},
  ) => {
    if (automationLoading()) return;
    const matchKind = options.matchKind ?? "sender";
    const matchValue = matchKind === "domain" ? senderDomainFromAddress(address) : address;
    if (!matchValue) return void prompts.error(t().incompleteSenderDomain);
    const initialConditions: MailAutomationConditions = {
      mode: "all",
      items: [
        matchKind === "sender"
          ? { field: "sender_address", operator: "is", value: matchValue }
          : { field: "sender_domain", operator: "is", value: matchValue },
      ],
    };
    // The editor loads on first use; until its modal opens, another choice must not open a second one.
    setAutomationLoading(true);
    const editor = await importOnDemand(() => import("./MailIncomingAutomationSettings"));
    setAutomationLoading(false);
    if (!editor) return;
    await editor.openIncomingAutomationEditor({
      mailboxId: props.mailboxId,
      initialName: options.name ?? t().messagesFrom({ value: matchValue }),
      initialScope: { mode: "matching", conditions: initialConditions },
      initialAction: options.action ?? "mark_read",
      onSaved: () => undefined,
    });
  };

  const reportPhishing = mutation.create<boolean, SelectionContext>({
    mutation: async (_, { abortSignal }) => {
      const confirmed = await prompts.confirm(t().phishingReportDescription, {
        title: t().reportPhishingTitle,
        confirmText: t().reportMessage,
      });
      if (!confirmed || abortSignal.aborted) return false;
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"]["security-report"].$post(
        { param: { mailboxId: props.mailboxId, messageId: props.message.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().reportFailed));
      return true;
    },
    onSuccess: (reported) => {
      if (reported) toast.success(t().reportSubmitted);
    },
    onError: (error) => toast.error(error.message),
  });

  const pending = () => reportPhishing.loading();
  const sender = () => props.message.from[0] ?? null;
  const findSenderHref = () => (sender() ? buildExactSenderSearchHref(mailRouteUrl(props.requestUrl), sender()!.address) : null);
  const actionVisibility = () =>
    resolveMailMessageActionVisibility({
      outgoing: isOutgoingMessage(props.message, props.identities),
      hasSender: Boolean(sender()),
      hasMailingListUnsubscribe: Boolean(props.message.mailingList?.unsubscribe),
      hasConversation: Boolean(props.selectedConversationId),
      totalMessageCount: props.totalMessageCount,
      canWrite: props.canWrite,
      canAdmin: props.canAdmin,
      mailboxWide: props.mailboxWide,
    });

  createEffect(
    on(
      () => props.selectionKey,
      () => {
        reportPhishing.abort();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    reportPhishing.abort();
  });

  // Who sent the message: the sender card offers these (Mail v5); the message's "…" keeps what concerns the message.
  const senderActions = (): SenderAction[] => {
    const address = sender()?.address;
    if (!address || !actionVisibility().findSender) return [];
    const visibility = actionVisibility();
    return [
      ...(findSenderHref() ? [{ id: "find" as const, label: t().findSender, icon: "ti ti-search", href: findSenderHref()! }] : []),
      ...(visibility.createIncomingAutomation
        ? [{ id: "automation" as const, label: t().createSenderAutomation, icon: "ti ti-filter-plus", action: () => void openIncomingAutomation(address) }]
        : []),
      ...(visibility.blockSender
        ? [
            {
              id: "block" as const,
              label: t().blockSender,
              icon: "ti ti-user-x",
              action: () => void openIncomingAutomation(address, { action: "junk", name: t().blockNamed({ value: address }) }),
            },
            ...(senderDomainFromAddress(address)
              ? [
                  {
                    id: "block-domain" as const,
                    label: t().blockSenderDomain,
                    icon: "ti ti-world-x",
                    action: () =>
                      void openIncomingAutomation(address, {
                        matchKind: "domain",
                        action: "junk",
                        name: t().blockNamed({ value: senderDomainFromAddress(address)! }),
                      }),
                  },
                ]
              : []),
          ]
        : []),
      ...(visibility.manageUnsubscribe && props.message.mailingList?.unsubscribe
        ? [
            {
              id: "unsubscribe" as const,
              label: t().manageUnsubscribe,
              icon: "ti ti-mail-off",
              href: buildMailingListHref(mailRouteUrl(props.requestUrl), props.message.mailingList.listKey),
            },
          ]
        : []),
    ];
  };

  const [inspectorLoading, setInspectorLoading] = createSignal(false);
  /** The inspector loads its code on first use; until its dialog opens, another choice must not open a second one. */
  const openTechnicalDetails = async () => {
    if (inspectorLoading()) return;
    setInspectorLoading(true);
    const inspector = await importOnDemand(() => import("./MailMessageInspectorDialog"));
    setInspectorLoading(false);
    if (!inspector) return;
    await inspector.openMailMessageInspector({
      mailboxId: props.mailboxId,
      messages: props.conversationMessages ?? [props.message],
      initialMessageId: props.message.id,
      initialTab: "headers",
    });
  };

  const items = (): DropdownItem[] => [
    ...(props.primaryActions ?? []),
    ...(actionVisibility().conversationRepair || actionVisibility().editAsNew
      ? [
          {
            sectionLabel: t().conversationSection,
            items: [
              ...(actionVisibility().editAsNew
                ? [{ label: t().useAsNew, icon: "ti ti-copy", action: () => props.onDeriveMessage("edit_as_new", props.message) }]
                : []),
              ...(actionVisibility().conversationRepair
                ? [
                    {
                      label: t().moveMessageConversation,
                      icon: "ti ti-message-forward",
                      action: () => props.onReassignMessage(props.message.id),
                    },
                    {
                      label: t().splitFromMessage,
                      icon: "ti ti-arrows-split-2",
                      action: () => props.onSplitMessage(props.message.id),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    {
      sectionLabel: t().other,
      items: [
        ...(sender() && actionVisibility().reportPhishing
          ? [
              {
                label: t().reportPhishing,
                icon: "ti ti-shield-exclamation",
                action: () => void reportPhishing.mutate({ selectionKey: props.selectionKey }),
              },
            ]
          : []),
        {
          label: mailReaderMessages.resolve([locale()]).t.technicalDetails,
          icon: inspectorLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-list-details",
          disabled: inspectorLoading(),
          action: () => void openTechnicalDetails(),
        },
      ],
    },
    ...cloudId.section({ messageId: props.message.id, conversationId: props.selectedConversationId }),
  ];

  return { items, senderActions, pending, automationLoading, label: () => t().messageActions };
}

export function MailMessageMenuTrigger(props: { menu: MailMessageMenu }) {
  return (
    <Dropdown.Root position="bottom-left" width="16rem" items={props.menu.items()}>
      <Dropdown.Trigger
        iconOnly
        size="sm"
        type="button"
        variant="ghost"
        label={props.menu.label()}
        disabled={props.menu.pending()}
        aria-busy={props.menu.automationLoading() ? "true" : undefined}
      >
        <i
          class={`ti ${props.menu.pending() || props.menu.automationLoading() ? "ti-loader-2 animate-spin" : "ti-dots"}`}
          aria-hidden="true"
        />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}

export default function MailSenderMessageActions(props: MailMessageMenuProps) {
  // Created once: a JSX prop expression would be re-run, with fresh state, on every read.
  const menu = createMailMessageMenu(props);
  return <MailMessageMenuTrigger menu={menu} />;
}
