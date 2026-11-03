import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { ConversationView, MailActivityKind } from "../contracts";
import { mailFolderNames } from "../folder-names";
import { readMailEventsFilter } from "../mail-events-route";
import { resolveMailSearchRoute } from "../search-state";
import type { MailActivityEvent } from "../service/collaboration";
import type { MessageDetail } from "../service/messages";
import type { MailboxListView, MailboxPageData, MailListItem } from "../service/workspace";
import { logFixtureItems } from "./_components/mail-automation-log-fixtures";
import { normalizeMailConversationToolbarActions } from "./_components/mail-conversation-toolbar";
import { mailTestFolder, mailTestRow } from "./_components/mail-list-test-fixtures";
import { summaryState } from "./_components/mail-summary-fixtures";
import { readMailUserPreferencesFromCookieHeader } from "./_components/mail-user-preferences";
import { readMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import MailWorkspace from "./MailWorkspace.island";

export const MAIL_SHELL_NOW = "2026-10-14T10:00:00.000Z";
/** `?trace=` picks what rules did with the open conversation (fictional, from the approved mockup). */
const traceFixture = (kind: string | null) => {
  const [sortUncertain, sortNora, sortAngebote, skippedCan, , , , manual] = [
    logFixtureItems[4]!,
    logFixtureItems[3]!,
    logFixtureItems[1]!,
    logFixtureItems[2]!,
    null,
    null,
    null,
    logFixtureItems[7]!,
  ];
  if (kind === "name") return [sortNora];
  if (kind === "uncertain") return [sortUncertain];
  if (kind === "manual") return [manual, sortAngebote];
  if (kind === "normal") return [skippedCan, sortAngebote];
  return [];
};
const summaryRule = { id: "Wf001", name: "Lange Mails zusammenfassen" };
/** `?summary=` picks the summary state the reader shows; without it the conversation has a person's short text. */
/** `photos=N`: the message carries an invented programme PDF and N invented photos. */
const photosFixture = (count: string | null): MessageDetail["attachments"] => {
  const photos = Number(count ?? 0);
  if (!Number.isSafeInteger(photos) || photos <= 0) return [];
  return [
    { id: "Att000", filename: "Programme.pdf", contentType: "application/pdf", sizeBytes: 182_000, contentId: null, checksum: null },
    ...Array.from({ length: photos }, (_, index) => ({
      id: `Att${String(index + 1).padStart(3, "0")}`,
      filename: `Summer_party_${index + 1}.jpg`,
      contentType: "image/jpeg",
      sizeBytes: 2_400_000 + index * 1000,
      contentId: null,
      checksum: null,
    })),
  ];
};

const summaryFixture = (kind: string | null) => {
  const ai = summaryState({
    summary:
      "- Neues Angebot: 500 Visitenkarten auf 350 g Naturpapier für 214 € netto (vorher 186 €).\n- Lieferung am 6.11. klappt nur mit Freigabe bis Mi., 29.10.\n- Offen: Freigabe oder Rückfrage zum Preis.",
    source: "workflow",
    author: { kind: "workflow", ...summaryRule },
    ai: true,
    generatedAt: new Date(Date.parse(MAIL_SHELL_NOW) - 3 * 60_000).toISOString(),
    coveredMessageCount: 5,
    nextStep: { text: "Freigabe bis Mi., 29.10.", due: "2026-10-29" },
    canGenerate: true,
  });
  switch (kind) {
    case "ai":
      return ai;
    case "stale":
      return { ...ai, newMessagesSince: 1 };
    case "writing":
      return { ...ai, summary: null, status: "writing" as const };
    case "failed":
      return {
        ...ai,
        summary: null,
        status: "failed" as const,
        failure: {
          code: "timeout" as const,
          attempts: 3,
          lastAttemptAt: new Date(Date.parse(MAIL_SHELL_NOW) - 60_000).toISOString(),
          workflow: summaryRule,
        },
      };
    case "limited":
      return {
        ...ai,
        summary: null,
        status: "limited" as const,
        limit: { scope: "rule" as const, workflow: summaryRule, limit: 200, resetsAt: "2026-10-14T22:00:00.000Z" },
        allowance: { unlimited: false, usedPercent: 24, resetsAt: null },
      };
    default:
      return summaryState({ summary: "Invented request summary.", summaryRevision: 1, conversationRevision: 1 });
  }
};
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
export const mailboxes = [
  ["Box001", "Example support"],
  ["Box002", "Example dispatch"],
  ["Box003", "Example correspondence with an exceptionally long mailbox name that must fade"],
  ["Box004", "Example projects"],
  ["Box005", "Example hidden"],
].map(([id, name]) => ({ ...mailbox(id!, name!), receivingAddress: `${id?.toLowerCase()}@example.test` as string | null }));
export const sidebar: ComponentProps<typeof MailWorkspace>["sidebar"] = {
  mailboxes,
  pinnedMailboxIds: ["Box002", "Box001"],
  hiddenMailboxIds: ["Box005"],
};
// Standard folders carry an Exchange-like provider's names; the sidebar shows them localized.
const standardFolderNames: Record<string, string> = {
  inbox: "INBOX",
  drafts: "Drafts",
  sent: "Sent Items",
  archive: "Archive",
  trash: "Deleted Items",
  junk: "Junk Email",
};
const folders = [
  ...["inbox", "drafts", "sent", "archive", "trash", "junk"].map((role) =>
    mailTestFolder(`${role[0]!.toUpperCase()}${role.slice(1)}1`, {
      role,
      providerRole: role,
      name: standardFolderNames[role]!,
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
/** The invented team of `?team=1`; the first person is the one signed in. */
const teamUsers = [
  { id: "user-1", uid: "robin", displayName: "Robin Example" },
  { id: "user-2", uid: "nora", displayName: "Nora Example" },
].map((user) => ({ ...user, avatarHash: null, scope: "mailbox" as const, permission: "write" as const, description: "" }));
/** Who wrote in a few rows: Conv02 the sender and the team, Conv03 three people, Conv05 seventeen (ten named). */
const crowd = ["Lea Brandt", "Tom Keller", "Anna Roth", "Ben Fischer", "Clara Hoff", "David Lang", "Eva Pohl", "Finn Braun", "Greta Vogel"];
const listParticipants: Record<number, Pick<MailListItem, "participants" | "participantCount">> = {
  1: { participants: [{ name: "Sender 2" }, { name: "Robin Example", kind: "user" }] },
  2: { participants: [{ name: "Sender 3" }, { name: "Nora Example", kind: "user" }, { name: "Invoices", kind: "workflow" }] },
  4: { participants: [{ name: "Sender 5" }, ...crowd.map((name) => ({ name, kind: "user" as const }))], participantCount: 17 },
};
export const listRows = Array.from({ length: 12 }, (_, index) =>
  mailTestRow(`Conv${String(index + 1).padStart(2, "0")}`, {
    subject: `Example request ${index + 1}`,
    participantSummary: `Sender ${index + 1}`,
    participantLabels: [`Sender ${index + 1}`],
    preview: `Invented preview for request ${index + 1}.`,
    latestMessageAt: new Date(Date.parse(MAIL_SHELL_NOW) - index * 3_600_000).toISOString(),
    unread: index % 2 === 0,
    flagged: index % 3 === 0,
    ...(index % 4 === 0 ? { attachmentCount: index / 4 + 1 } : {}),
    ...listParticipants[index],
    activeFolderIds: ["Inbox1"],
    sourceFolderId: "Inbox1",
    unreadFolderIds: index % 2 === 0 ? ["Inbox1"] : [],
    localTags: index === 0 ? localTags.slice(0, 1) : [],
  }),
);
/** Assigned to me (`?view=mine`): the service lists the three that need action before the two that wait. */
const mineRows = listRows
  .slice(0, 5)
  .map((row, index) => ({ ...row, assigneeUserIds: ["user-1"], workStatus: index < 3 ? ("needs_action" as const) : ("waiting" as const) }));
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

const people = {
  me: { id: "user-1", displayName: "Lea Brandt", avatarHash: null },
  jonas: { id: "11111111-1111-4111-8111-000000000001", displayName: "Jonas Weber", avatarHash: null },
  mira: { id: "11111111-1111-4111-8111-000000000002", displayName: "Mira Schulz", avatarHash: null },
  tom: { id: "11111111-1111-4111-8111-000000000003", displayName: "Tom Keller", avatarHash: null },
  clara: { id: "11111111-1111-4111-8111-000000000004", displayName: "Clara Hoff", avatarHash: null },
};
type FixtureEvent = MailActivityEvent & { kind: MailActivityKind; mine?: boolean };
const at = (minutes: number) => new Date(Date.parse(MAIL_SHELL_NOW) - minutes * 60_000).toISOString();
const fixtureEvent = (
  id: number,
  kind: MailActivityKind,
  actor: { id: string; displayName: string; avatarHash: null } | { workflow: string },
  minutes: number,
  input: Partial<MailActivityEvent>,
  mine = false,
): FixtureEvent => ({
  id: String(id),
  kind,
  mine,
  conversationId: "Conv01",
  conversationSubject: "Example request 1",
  actor: "workflow" in actor ? { kind: "workflow", id: null, displayName: actor.workflow, avatarHash: null } : { kind: "user", ...actor },
  action: "conversation.comment_created",
  outcome: "confirmed",
  targetType: "conversation",
  targetId: null,
  metadata: {},
  createdAt: at(minutes),
  assignees: null,
  ...input,
});
/** Invented feed events after the approved mockup: today and yesterday, every kind, one failed send. */
const fixtureEvents: FixtureEvent[] = [
  fixtureEvent(12, "assignment", people.jonas, 16, {
    action: "conversation.collaboration_updated",
    metadata: { before: { assigneeUserIds: [] }, after: { assigneeUserIds: [people.jonas.id] } },
    assignees: { before: [], after: [people.jonas] },
  }),
  fixtureEvent(11, "sent", people.mira, 17, { action: "message.sent", metadata: { result: "sent", intent: "reply" } }),
  fixtureEvent(10, "automation", { workflow: "Rechnungen" }, 19, {
    action: "conversation.local_tags_added",
    metadata: { addedTagIds: ["Tag001"] },
  }),
  fixtureEvent(9, "draft", people.tom, 30, { action: "draft.created", conversationId: "Conv02", conversationSubject: "Example request 2" }),
  fixtureEvent(8, "comment", people.mira, 40, { conversationId: "Conv02", conversationSubject: "Example request 2" }, true),
  fixtureEvent(
    7,
    "assignment",
    people.jonas,
    47,
    {
      action: "conversation.collaboration_updated",
      conversationId: "Conv02",
      conversationSubject: "Example request 2",
      metadata: { before: { assigneeUserIds: [people.jonas.id] }, after: { assigneeUserIds: [people.jonas.id, people.me.id] } },
      assignees: { before: [people.jonas], after: [people.jonas, people.me] },
    },
    true,
  ),
  fixtureEvent(6, "sent", people.clara, 62, {
    action: "message.sent",
    outcome: "failed",
    conversationId: "Conv04",
    conversationSubject: "Example request 4",
    metadata: { result: "failed", intent: "reply", code: "SMTP_REJECTED" },
  }),
  fixtureEvent(5, "status", people.tom, 80, {
    action: "conversation.collaboration_updated",
    conversationId: "Conv03",
    conversationSubject: "Example request 3",
    metadata: { before: { workStatus: "needs_action" }, after: { workStatus: "done" } },
  }),
  fixtureEvent(4, "sent", people.jonas, 17 * 60, {
    action: "message.sent",
    conversationId: "Conv04",
    conversationSubject: "Example request 4",
    metadata: { result: "sent", intent: "reply" },
  }),
  fixtureEvent(
    3,
    "assignment",
    people.me,
    20 * 60,
    {
      action: "conversation.collaboration_updated",
      conversationId: "Conv05",
      conversationSubject: "Example request 5",
      metadata: { before: { assigneeUserIds: [] }, after: { assigneeUserIds: [people.mira.id] } },
      assignees: { before: [], after: [people.mira] },
    },
    true,
  ),
  fixtureEvent(2, "draft", people.tom, 23 * 60, {
    action: "draft.discarded",
    conversationId: "Conv06",
    conversationSubject: "Example request 6",
  }),
];
/** Older events that "Load older events" brings, from the activity API. */
export const olderFixtureEvents: MailActivityEvent[] = [
  fixtureEvent(1, "status", people.mira, 30 * 60, {
    action: "conversation.collaboration_updated",
    conversationId: "Conv07",
    conversationSubject: "Example request 7",
    metadata: { before: { workStatus: "done" }, after: { workStatus: "needs_action" } },
  }),
];
/** `?view=events` with `events=empty|error|more`, filtered like the server by `eventKind`, `eventActor` and `eventMine`. */
const eventsFixture = (url: URL): Pick<MailboxPageData, "eventsMode" | "eventsPage" | "eventsError"> => {
  if (url.searchParams.get("view") !== "events") return { eventsMode: false, eventsPage: null, eventsError: null };
  const state = url.searchParams.get("events");
  if (state === "error")
    return { eventsMode: true, eventsPage: null, eventsError: "The server did not answer in time. Your mailbox is unchanged." };
  const filter = readMailEventsFilter(url);
  const items =
    state === "empty"
      ? []
      : fixtureEvents
          .filter((event) => (!filter.kind || event.kind === filter.kind) && (!filter.mine || event.mine))
          .filter((event) => !filter.actorId || event.actor.id === filter.actorId)
          .map(({ kind: _kind, mine: _mine, ...event }) => event);
  return {
    eventsMode: true,
    eventsPage: {
      items,
      nextCursor: state === "more" ? "cursor-older" : null,
      filter,
      people: [people.me, people.jonas, people.mira, people.tom, people.clara],
    },
    eventsError: null,
  };
};

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
    // Older shell tests pin "list and reader"; the columns view (F2) opts in with ?layout=auto|columns.
    viewPreference: {
      large: url.searchParams.get("layout") === "auto" ? "auto" : url.searchParams.get("layout") === "columns" ? "columns" : "split",
      phone: "compact",
    },
    // ?done=19,14 sets today's completed conversations and how many automations completed.
    doneTodayCounts: (() => {
      const [done = 0, automated = 0] = (url.searchParams.get("done") ?? "").split(",").map((value) => Number(value) || 0);
      return { doneToday: done, doneByAutomation: automated };
    })(),
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
    ...eventsFixture(url),
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
      scheduledMode || draftsMode || url.searchParams.get("view") === "events" || url.searchParams.get("inbox") === "empty"
        ? []
        : activeView === "mine"
          ? mineRows
          : selectedMailbox.id === "Box001"
            ? // ?team=1: a shared mailbox where Nora Example already answers for the first conversation.
              url.searchParams.has("team")
              ? listRows.map((row, index) => (index === 0 ? { ...row, assigneeUserIds: [teamUsers[1]!.id] } : row))
              : listRows
            : listRows.map((row) => ({
                ...row,
                id: `${selectedMailbox.id}-${row.id}`,
                conversationId: `${selectedMailbox.id}-${row.conversationId}`,
                subject: `${selectedMailbox.name}: ${row.subject}`,
              })),
    listCursor: null,
    nextListCursor: null,
    listError: null,
    // ?hidden=1207 names done conversations the list leaves out; "more" is over the count window, "unknown" uncounted.
    // Assigned to me: three conversations need action and two wait for a reply.
    assignedGroups: activeView === "mine" ? { needsAction: 3, waiting: 2 } : null,
    hiddenDone: (() => {
      const hidden = url.searchParams.get("hidden");
      if (!hidden) return null;
      if (hidden === "unknown") return { count: null, more: false };
      return hidden === "more" ? { count: 1000, more: true } : { count: Number(hidden) || 0, more: false };
    })(),
    listTitle: searching
      ? "Search results"
      : scheduledMode
        ? "Outbox"
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
            : (() => {
                const folder = folders.find((folder) => folder.id === folderId);
                return folder ? mailFolderNames(url.searchParams.get("locale") === "de" ? "de" : "en")(folder) : "All mail";
              })(),
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
              attachments: photosFixture(url.searchParams.get("photos")),
            },
          ]
      : [],
    conversationSummary: selectedConversationId ? summaryFixture(url.searchParams.get("summary")) : null,
    conversationDrafts: [],
    automationTrace: selectedConversationId ? traceFixture(url.searchParams.get("trace")) : [],
    detailError: null,
    collaborationState: selectedConversationId
      ? {
          conversationId: selectedConversationId,
          assignees: url.searchParams.has("team") && selectedConversationId === "Conv01" ? [teamUsers[1]!] : [],
          // ?work=done opens a conversation that is already done.
          workStatus: url.searchParams.get("work") === "done" ? "done" : "needs_action",
          snoozedUntil: null,
          revision: 1,
        }
      : null,
    localTags,
    conversationLocalTags: selectedConversationId
      ? { conversationId: selectedConversationId, conversationRevision: 1, tags: localTags.slice(0, 1) }
      : null,
    comments: [],
    commentsCursor: null,
    assignableUsers: url.searchParams.has("team") ? teamUsers : [],
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
    eventsMode,
    eventsPage,
    eventsError,
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
    hiddenDone,
    assignedGroups,
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
    eventsMode,
    eventsPage,
    eventsError,
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
    hiddenDone,
    assignedGroups,
    listTitle,
  };
}

export default function MailShellFixture(props: {
  source: string;
  locale?: "en" | "de";
  theme: "light" | "dark";
  workspaceCookieHeader?: string | null;
  /** `?notice=1` until the fixture server stored the person's click on "Got it". */
  focusNoticeOpen?: boolean;
}) {
  const url = new URL(props.source, "http://mail.example.test");
  const locale = props.locale ?? "en";
  const data = mailboxData(url);
  return (
    <LocaleProvider locale={locale}>
      <MailWorkspace
        data={data}
        requestPath={props.source}
        currentUserId="user-1"
        currentUserEmail="reader@example.test"
        contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        cloudUrl="https://cloud.example"
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
        sidebar={{ ...sidebar, focusNoticeOpen: props.focusNoticeOpen ?? false }}
      />
    </LocaleProvider>
  );
}
