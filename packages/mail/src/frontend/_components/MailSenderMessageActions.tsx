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
  onReassignMessage: (messageId: string) => void | Promise<void>;
  onSplitMessage: (messageId: string) => void | Promise<void>;
  onDeriveMessage: (kind: DraftDerivationKind, message: MailWorkspaceMessage) => unknown;
};

export type MailMessageMenu = ReturnType<typeof createMailMessageMenu>;

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

  const items = (): DropdownItem[] => [
    ...(props.primaryActions ?? []),
    ...(sender() && actionVisibility().findSender
      ? [
          {
            sectionLabel: t().sender,
            items: [
              ...(findSenderHref() ? [{ label: t().findSender, icon: "ti ti-search", href: findSenderHref()! }] : []),
              ...(actionVisibility().createIncomingAutomation
                ? [
                    {
                      label: t().createSenderAutomation,
                      icon: "ti ti-filter-plus",
                      action: () => void openIncomingAutomation(sender()!.address),
                    },
                  ]
                : []),
              ...(actionVisibility().blockSender
                ? [
                    {
                      label: t().blockSender,
                      icon: "ti ti-user-x",
                      action: () =>
                        void openIncomingAutomation(sender()!.address, {
                          action: "junk",
                          name: t().blockNamed({ value: sender()!.address }),
                        }),
                    },
                    ...(senderDomainFromAddress(sender()!.address)
                      ? [
                          {
                            label: t().blockSenderDomain,
                            icon: "ti ti-world-x",
                            action: () =>
                              void openIncomingAutomation(sender()!.address, {
                                matchKind: "domain",
                                action: "junk",
                                name: t().blockNamed({ value: senderDomainFromAddress(sender()!.address)! }),
                              }),
                          },
                        ]
                      : []),
                  ]
                : []),
              ...(actionVisibility().manageUnsubscribe && props.message.mailingList?.unsubscribe
                ? [
                    {
                      label: t().manageUnsubscribe,
                      icon: "ti ti-mail-off",
                      href: buildMailingListHref(mailRouteUrl(props.requestUrl), props.message.mailingList.listKey),
                    },
                  ]
                : []),
              ...(actionVisibility().reportPhishing
                ? [
                    {
                      label: t().reportPhishing,
                      icon: "ti ti-shield-exclamation",
                      action: () => void reportPhishing.mutate({ selectionKey: props.selectionKey }),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    ...(actionVisibility().conversationRepair
      ? [
          {
            sectionLabel: t().conversationSection,
            items: [
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
    ...(actionVisibility().editAsNew
      ? [
          {
            label: t().useAsNew,
            icon: "ti ti-copy",
            action: () => props.onDeriveMessage("edit_as_new", props.message),
          },
        ]
      : []),
    ...cloudId.section({ messageId: props.message.id, conversationId: props.selectedConversationId }),
  ];

  return { items, pending, automationLoading, label: () => t().messageActions };
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
