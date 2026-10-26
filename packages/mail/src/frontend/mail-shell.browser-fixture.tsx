import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { ConversationView, MailFocusPage, MailFocusView } from "../contracts";
import { resolveMailSearchRoute } from "../search-state";
import type { MailboxListView, MailboxPageData } from "../service/workspace";
import { normalizeMailConversationToolbarActions } from "./_components/mail-conversation-toolbar";
import { mailTestFolder, mailTestRow } from "./_components/mail-list-test-fixtures";
import { summaryState } from "./_components/mail-summary-fixtures";
import { readMailUserPreferencesFromCookieHeader } from "./_components/mail-user-preferences";
import { readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import MailOverview from "./MailOverview.island";
import MailWorkspace from "./MailWorkspace.island";

export const MAIL_SHELL_NOW = "2026-10-14T10:00:00.000Z";
export const focusCounts = { mine: 12, unassigned: 7, waiting: 4, all: 23 };
export const viewCounts = {
  needs_action: 12,
  mine: 5,
  unassigned: 7,
  waiting: 4,
  done: 3,
  snoozed: 2,
  send_problems: 1,
  recently_active: 9,
  kept: 6,
};
export type Permission = "write" | "read" | "admin" | "assigned-only";
export const fixturePermission = (url: URL): Permission => {
  const value = url.searchParams.get("permission");
  return value === "read" || value === "admin" || value === "assigned-only" ? value : "write";
};
export const focusView = (url: URL): MailFocusView => {
  const view = url.searchParams.get("view");
  return view === "waiting" || view === "unassigned" || view === "all" ? view : "mine";
};
const mailbox = (id: string, name: string): MailboxPageData["mailbox"] => ({
  id,
  name,
  description: null,
  health: "active",
  healthReason: null,
  syncEnabled: true,
  searchBackend: "auto",
  automaticReplyManagementPermission: "admin",
  accessScope: "mailbox",
  composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
  createdAt: MAIL_SHELL_NOW,
  updatedAt: MAIL_SHELL_NOW,
});
export const mailboxes: ComponentProps<typeof MailOverview>["mailboxes"] = [
  ["Box001", "Example support"],
  ["Box002", "Example dispatch"],
  ["Box003", "Example correspondence with an exceptionally long mailbox name that must fade"],
  ["Box004", "Example projects"],
  ["Box005", "Example hidden"],
].map(([id, name]) => ({ ...mailbox(id!, name!), permission: "write", receivingAddress: `${id?.toLowerCase()}@example.test` }));
export const sidebar: ComponentProps<typeof MailWorkspace>["sidebar"] = {
  mailboxes,
  pinnedMailboxIds: ["Box002", "Box001"],
  hiddenMailboxIds: ["Box005"],
};
const focusMailboxCounts = mailboxes.map((box, index) => ({ mailboxId: box.id, unread: index + 2, needsAction: index + 3 }));
const folders = [
  ...["inbox", "drafts", "sent", "archive", "trash", "junk"].map((role) =>
    mailTestFolder(`${role[0]!.toUpperCase()}${role.slice(1)}1`, {
      role,
      providerRole: role,
      name: `${role[0]!.toUpperCase()}${role.slice(1)}`,
      unread: role === "sent" || role === "drafts" ? 0 : 3,
    }),
  ),
  mailTestFolder("Filed1", { role: "custom", providerRole: "custom", name: "Filed", unread: 7 }),
  mailTestFolder("Quiet1", { role: "custom", providerRole: "custom", name: "Quiet", display: "hidden", unread: 0 }),
  mailTestFolder("Child1", { role: "custom", providerRole: "custom", name: "Nested", parentId: "Filed1", unread: 2 }),
  mailTestFolder("Long01", {
    role: "custom",
    providerRole: "custom",
    name: "Example folder with a very long name that must fade",
    unread: 11,
  }),
];
const localTags: MailboxPageData["localTags"] = [
  {
    id: "Tag001",
    mailboxId: "Box001",
    name: "Priority",
    color: "#ef4444",
    revision: 1,
    createdAt: MAIL_SHELL_NOW,
    updatedAt: MAIL_SHELL_NOW,
  },
  {
    id: "Tag002",
    mailboxId: "Box001",
    name: "Orders",
    color: "#3b82f6",
    revision: 1,
    createdAt: MAIL_SHELL_NOW,
    updatedAt: MAIL_SHELL_NOW,
  },
];
export const listRows = Array.from({ length: 12 }, (_, index) =>
  mailTestRow(`Conv${String(index + 1).padStart(2, "0")}`, {
    subject: `Example request ${index + 1}`,
    participantSummary: `Sender ${index + 1}`,
    participantLabels: [`Sender ${index + 1}`],
    preview: `Invented preview for request ${index + 1}.`,
    latestMessageAt: new Date(Date.parse(MAIL_SHELL_NOW) - index * 3_600_000).toISOString(),
    unread: index % 2 === 0,
    flagged: index % 3 === 0,
    hasAttachments: index % 4 === 0,
    activeFolderIds: ["Inbox1"],
    sourceFolderId: "Inbox1",
    unreadFolderIds: index % 2 === 0 ? ["Inbox1"] : [],
    localTags: index === 0 ? localTags.slice(0, 1) : [],
  }),
);
export const focusPage = (view: MailFocusView): MailFocusPage => ({
  items: listRows
    .slice(0, Math.min(focusCounts[view], 12))
    .map((row) => ({ ...row, mailboxId: "Box001", mailboxName: "Example support", workStatus: row.workStatus ?? "needs_action" })),
  nextCursor: null,
  counts: focusCounts,
  mailboxCounts: focusMailboxCounts,
});

/** Conv02 is a long conversation: six messages, oldest first as the service sends them, so the reader folds the older ones. */
const longThread: MailboxPageData["detailMessages"] = Array.from({ length: 6 }, (_, index) => {
  const at = new Date(Date.parse(MAIL_SHELL_NOW) - (5 - index) * 86_400_000).toISOString();
  const text = `Invented message ${index + 1} of a long conversation.`;
  return {
    id: `Long0${index + 1}`,
    subject: "Example request 2",
    messageId: `<long0${index + 1}@example.test>`,
    internalDate: at,
    sentAt: at,
    from: [{ name: index % 2 ? "Example support" : "Example sender", address: index % 2 ? "support@example.test" : "sender@example.test" }],
    to: [{ name: "Example support", address: "support@example.test" }],
    preview: text,
    hasAttachments: false,
    replyTo: [],
    cc: [],
    flags: ["\\Seen"],
    keywords: [],
    hydrationStatus: "complete",
    remoteAvailable: true,
    folderId: "Inbox1",
    deletedOnServer: false,
    contentType: "text/plain",
    sizeBytes: 64,
    plainText: text,
    sanitizedHtml: null,
    forwardText: text,
    selectedHeaders: {},
    sourceAvailable: true,
    mailingList: null,
    remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.test", domain: "example.test" },
    delivery: null,
    attachments: [],
  };
});

/** URL state is resolved for every SSR request and every in-place workspace API read. */
export function mailboxData(url: URL): MailboxPageData {
  const variant = fixturePermission(url);
  const permission = variant === "assigned-only" ? "write" : variant;
  const search = resolveMailSearchRoute(url);
  const searching = Boolean(search.query || search.expression);
  const folderId =
    Object.hasOwn(viewCounts, url.searchParams.get("view") ?? "") || url.searchParams.has("savedView")
      ? null
      : url.searchParams.get("folder");
  const scheduledMode = !searching && url.searchParams.get("scheduled") === "1";
  const draftsMode = folderId === "Drafts1";
  const savedViewId = searching || folderId || scheduledMode ? null : url.searchParams.get("savedView");
  const requestedView = url.searchParams.get("view");
  const activeView: ConversationView | null =
    !searching && !folderId && !scheduledMode && !savedViewId && requestedView && Object.hasOwn(viewCounts, requestedView)
      ? (requestedView as ConversationView)
      : null;
  const selectedConversationId = url.searchParams.get("conversation");
  const selectedMailbox = mailboxes.find((box) => box.id === url.pathname.split("/").at(-1)) ?? mailboxes[0]!;
  return {
    receivingAddress: selectedMailbox.id === "Box001" ? "support@example.test" : selectedMailbox.receivingAddress,
    mailbox: selectedMailbox,
    permission,
    access: { scope: variant === "assigned-only" ? "assigned" : "mailbox", permission },
    initialLiveCursor: "s6t.mail.4",
    folders,
    identities: [],
    scheduledMode,
    scheduledCount: 2,
    scheduledPage: scheduledMode ? { items: [], nextCursor: null, total: 0 } : null,
    scheduledError: null,
    draftsMode,
    draftsPage: draftsMode
      ? {
          items: url.searchParams.has("drafts-fixture")
            ? ["Quarterly figures", "Workshop follow-up"].map((subject, index) => ({
                id: `Draft${index + 1}`,
                conversationId: null,
                intent: "new" as const,
                subject,
                to: [{ name: "Ada Example", address: "ada@example.test" }],
                cc: [],
                bcc: [],
                bodyPreview: "Invented draft text for the compact mailbox view.",
                createdByDisplayName: "Example writer",
                // Keep relative wording stable while the browser clock advances through hydration.
                updatedAt: "2026-10-13T04:00:00.000Z",
              }))
            : [],
          nextCursor: url.searchParams.has("drafts-cursor") ? "next" : null,
          total: url.searchParams.has("drafts-fixture") ? 2 : 0,
        }
      : null,
    draftsError: null,
    activeView,
    savedViewId,
    savedViews: ["Priority view", "Team view"].map((name, index) => ({
      id: `Saved${index + 1}`,
      mailboxId: "Box001",
      name,
      scope: "mailbox",
      ownerUserId: null,
      filter: { expression: { type: "work_status", value: "needs_action" }, sort: "newest" },
      revision: 1,
      createdAt: MAIL_SHELL_NOW,
      updatedAt: MAIL_SHELL_NOW,
    })),
    listMode: "conversations",
    folderId,
    viewCounts,
    query: search.query,
    search,
    selectedConversationId,
    selectedMessageId: url.searchParams.get("message"),
    listItems:
      scheduledMode || draftsMode
        ? []
        : selectedMailbox.id === "Box001"
          ? listRows
          : listRows.map((row) => ({
              ...row,
              id: `${selectedMailbox.id}-${row.id}`,
              conversationId: `${selectedMailbox.id}-${row.conversationId}`,
              subject: `${selectedMailbox.name}: ${row.subject}`,
            })),
    listCursor: null,
    nextListCursor: null,
    listError: null,
    listTitle: searching
      ? "Search results"
      : scheduledMode
        ? "Scheduled"
        : savedViewId
          ? savedViewId === "Saved1"
            ? "Priority view"
            : "Team view"
          : activeView
            ? {
                needs_action: "Needs action",
                mine: "Assigned to me",
                unassigned: "Unassigned",
                waiting: "Waiting for reply",
                done: "Done",
                snoozed: "Later",
                send_problems: "Send problems",
                recently_active: "Recent activity",
                kept: "Kept",
              }[activeView]
            : (folders.find((folder) => folder.id === folderId)?.name ?? "All mail"),
    conversationRowState: null,
    detailMessages: selectedConversationId
      ? selectedConversationId === "Conv02"
        ? longThread.map((message, index) =>
            url.searchParams.has("long-subject") && index === longThread.length - 1
              ? {
                  ...message,
                  plainText: Array.from(
                    { length: 50 },
                    (_, line) => `Delivery note ${line + 1}: Please check the revised exhibition schedule.`,
                  ).join("\n\n"),
                }
              : message,
          )
        : [
            {
              id: "Msg001",
              subject: "Example request 1",
              messageId: "<msg001@example.test>",
              internalDate: MAIL_SHELL_NOW,
              sentAt: MAIL_SHELL_NOW,
              from: [{ name: "Example sender", address: "sender@example.test" }],
              to: [{ name: "Example support", address: "support@example.test" }],
              preview: "Invented message for the browser suite.",
              hasAttachments: false,
              replyTo: [],
              cc: [],
              flags: ["\\Seen"],
              keywords: [],
              hydrationStatus: "complete",
              remoteAvailable: true,
              folderId: "Inbox1",
              deletedOnServer: false,
              contentType: "text/plain",
              sizeBytes: 64,
              plainText: "Invented message for the browser suite.",
              sanitizedHtml: null,
              forwardText: "Invented message for the browser suite.",
              selectedHeaders: {},
              sourceAvailable: true,
              mailingList: null,
              remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.test", domain: "example.test" },
              delivery: null,
              attachments: [],
            },
          ]
      : [],
    conversationSummary: selectedConversationId
      ? summaryState({ summary: "Invented request summary.", summaryRevision: 1, conversationRevision: 1 })
      : null,
    conversationDrafts: [],
    detailError: null,
    collaborationState: selectedConversationId
      ? { conversationId: selectedConversationId, assignees: [], workStatus: "needs_action", snoozedUntil: null, revision: 1 }
      : null,
    localTags,
    conversationLocalTags: selectedConversationId
      ? { conversationId: selectedConversationId, conversationRevision: 1, tags: localTags.slice(0, 1) }
      : null,
    comments: [],
    commentsCursor: null,
    assignableUsers: [],
    activity: [],
    reminder: null,
    keep: null,
    collaborationError: null,
    detailErrors: {
      collaboration: null,
      tags: null,
      comments: null,
      assignableUsers: null,
      activity: null,
      reminder: null,
      keep: null,
      reference: null,
      summary: null,
      drafts: null,
    },
    selectedSubject: url.searchParams.has("long-subject")
      ? "Delivery confirmation for the autumn exhibition — review the revised schedule and delivery documents before Wednesday"
      : selectedConversationId
        ? "Example request 1"
        : "",
    selectedReference: null,
  };
}
export function mailboxList(url: URL): MailboxListView {
  const {
    mailbox,
    permission,
    access,
    savedViews,
    scheduledMode,
    scheduledPage,
    scheduledError,
    draftsMode,
    draftsPage,
    draftsError,
    activeView,
    savedViewId,
    listMode,
    folderId,
    query,
    search,
    listItems,
    listCursor,
    nextListCursor,
    listError,
    listTitle,
  } = mailboxData(url);
  return {
    mailbox,
    permission,
    access,
    savedViews,
    scheduledMode,
    scheduledPage,
    scheduledError,
    draftsMode,
    draftsPage,
    draftsError,
    activeView,
    savedViewId,
    listMode,
    folderId,
    query,
    search,
    listItems,
    listCursor,
    nextListCursor,
    listError,
    listTitle,
  };
}

export default function MailShellFixture(props: {
  source: string;
  locale?: "en" | "de";
  theme: "light" | "dark";
  workspaceCookieHeader?: string | null;
}) {
  const url = new URL(props.source, "http://mail.example.test");
  const locale = props.locale ?? "en";
  const data = mailboxData(url);
  const overview = {
    pages: { mine: focusPage("mine"), unassigned: focusPage("unassigned"), waiting: focusPage("waiting"), all: focusPage("all") },
    counts: focusCounts,
    mailboxCounts: focusMailboxCounts,
  };
  return (
    <LocaleProvider locale={locale}>
      {url.pathname === "/app/mail" ? (
        <MailOverview
          mailboxes={mailboxes}
          initialFocus={overview}
          initialFocusError={null}
          initialView={focusView(url)}
          initialSelection={null}
          initialDetail={null}
          initialPinnedMailboxIds={sidebar.pinnedMailboxIds}
          initialHiddenMailboxIds={sidebar.hiddenMailboxIds}
          currentUserEmail="reader@example.test"
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
          dateConfig={{ locale, timeZone: "UTC" }}
        />
      ) : (
        <MailWorkspace
          data={data}
          requestPath={props.source}
          currentUserId="user-1"
          currentUserEmail="reader@example.test"
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
          dateConfig={{ locale, timeZone: "UTC" }}
          initialPreferences={{
            ...readMailWorkspacePreferences(""),
            detailsOpen: url.searchParams.has("persist-details")
              ? readMailWorkspacePreferences(props.workspaceCookieHeader).detailsOpen
              : url.searchParams.get("details") === "1",
            listCollapsed: url.searchParams.get("list") === "hidden",
            // A person's own toolbar (`?toolbar=reply,archive`), as the preference cookie stores it.
            ...(url.searchParams.has("toolbar")
              ? { toolbarActions: normalizeMailConversationToolbarActions(url.searchParams.get("toolbar")!.split(",")) }
              : {}),
          }}
          initialUserPreferences={readMailUserPreferencesFromCookieHeader("", data.mailbox.id)}
          initialTheme={props.theme}
          calendarIntegrationAvailable={false}
          sidebar={sidebar}
        />
      )}
    </LocaleProvider>
  );
}
