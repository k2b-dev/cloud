import { mailTestFolder, mailTestRow } from "../../src/frontend/_components/mail-list-test-fixtures";
import type { MailboxPageData } from "../../src/service/workspace";
import { anchor, planLargeMailbox } from "./large-mailbox";

function createScaleFixture() {
  /** Same seeded mailbox as the SQL guard: real thread sizes, dates and folder distribution. */
  const folderScalePlan = planLargeMailbox({ seed: 20261117, anchor, messages: 1800, conversations: 600, folders: 12 });
  const folderIds = folderScalePlan.folders.map((folder, index) => (index === 0 ? "Inbox1" : index === 2 ? "Archive1" : folder.id));
  const folders = folderScalePlan.folders.map((folder, index) =>
    mailTestFolder(folderIds[index]!, {
      role: folder.role,
      providerRole: folder.role,
      name: folder.name,
      parentId: folder.parent === null ? null : folderIds[folder.parent]!,
      ...folderScalePlan.shape.totals[folder.id],
    }),
  );
  const rows = folderScalePlan.conversations.map((conversation) => {
    const messages = folderScalePlan.messages.filter((message) => message.conversation === conversation.id);
    const latest = messages.at(-1)!;
    const workStatus = conversation.status;
    if (workStatus !== "done" && workStatus !== "waiting" && workStatus !== "needs_action") throw new Error("Invalid fixture status");
    const folderId = folderIds[conversation.folder]!;
    const unread = messages.some((message) => !message.flags.includes("\\Seen"));
    return mailTestRow(conversation.id, {
      subject: latest.subject,
      preview: latest.text,
      latestMessageAt: latest.date,
      participantLabels: [latest.from],
      participantSummary: latest.from,
      messageCount: messages.length,
      unread,
      flagged: messages.some((message) => message.flags.includes("\\Flagged")),
      activeFolderIds: [folderId],
      sourceFolderId: folderId,
      unreadFolderIds: unread ? [folderId] : [],
      workStatus,
      snoozedUntil: conversation.snoozedUntil,
    });
  });

  return { folders, rows };
}
let fixture: ReturnType<typeof createScaleFixture> | undefined;

export function scaleMailboxData(data: MailboxPageData, url: URL): MailboxPageData {
  fixture ??= createScaleFixture();
  const { folders, rows } = fixture;
  const folderId = url.searchParams.get("folder") ?? "Inbox1";
  // First cursor page: the service limits the list to 50, irrespective of mailbox size.
  const listItems = rows
    .filter((row) => row.sourceFolderId === folderId && (folderId !== "Inbox1" || (row.workStatus !== "done" && !row.snoozedUntil)))
    .sort((a, b) => b.latestMessageAt.localeCompare(a.latestMessageAt))
    .slice(0, 50);
  return {
    ...data,
    folders,
    folderId,
    listItems,
    // Measure the first-page commit without automatically fetching the next page.
    nextListCursor: null,
    listTitle: folders.find((folder) => folder.id === folderId)?.name ?? "Inbox",
  };
}
