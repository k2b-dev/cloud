import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MailFolderView } from "../../service/messages";
import type { MailListItem } from "./mail-navigation";

const folder = (id: string, name: string, role: string): MailFolderView => ({
  id,
  parentId: null,
  name,
  role,
  providerRole: role,
  configuredRole: null,
  selectable: true,
  display: "everywhere",
  effectiveDisplay: "everywhere",
  displayInheritedFromFolderId: null,
  displayNeutral: false,
  namespaceKinds: ["personal"],
  discoveryState: "active",
  missingSince: null,
  syncStatus: "current",
  total: 0,
  unread: 0,
});

// One row of a message list: the question in the Inbox, while its conversation's newer reply has
// its own row from Sent.
const question: MailListItem = {
  id: "Msg002",
  conversationId: "Conv01",
  selectionKind: "message",
  primaryReference: null,
  subject: "Delivery question",
  participantSummary: "customer@example.test",
  participantLabels: ["customer@example.test"],
  latestMessageAt: "2026-08-19T10:00:00.000Z",
  preview: null,
  attachmentMatch: null,
  unread: false,
  activeFolderIds: ["inbox"],
  flagged: false,
  hasAttachments: false,
  messageCount: 2,
  workStatus: "needs_action",
  assigneeUserIds: [],
  snoozedUntil: null,
  sourceFolderId: "inbox",
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
};

const dragEvent = (window: ReturnType<typeof createDomTestHarness>["window"], type: string, data: Map<string, string>) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? "",
    },
  });
  return event as unknown as Event;
};

if (!isServer) {
  test("dropping a row on a folder moves that row, not another row of its conversation", async () => {
    const dom = createDomTestHarness();
    const { default: MailConversationRow } = await import("./MailConversationRow");
    const { default: MailSidebar } = await import("./MailSidebar");
    const moves: Array<{ itemId: string; destinationFolderId: string }> = [];
    const dispose = render(
      () => (
        <>
          <MailSidebar
            mailboxId="Box001"
            mailboxName="Support"
            syncEnabled={true}
            needsConnection={false}
            folders={[folder("inbox", "Inbox", "inbox"), folder("projects", "Projects", "other")]}
            localTags={[]}
            savedViews={[]}
            scheduledMode={false}
            scheduledCount={0}
            activeFolderId={null}
            activeView={null}
            activeSavedViewId={null}
            activeTagId={null}
            searchActive={false}
            viewCounts={{ needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0 }}
            canWrite={true}
            canAdmin={false}
            assignedOnly={false}
            managementOpening={null}
            settingsOpening={false}
            detailsOpening={false}
            onOpenDetails={() => {}}
            onOpenHealth={() => {}}
            onOpenSharedLinks={() => {}}
            onOpenRemoteContent={() => {}}
            onOpenSubscriptions={() => {}}
            onOpenSettings={() => {}}
            onMoveConversation={(input) => void moves.push(input)}
            onNavigate={() => {}}
          />
          <MailConversationRow
            item={question}
            requestUrl={new URL("https://cloud.example/app/mail/Box001?list=messages")}
            state={{
              selectedConversationId: null,
              selectedMessageId: null,
              selectedConversationIds: new Set<string>(),
              selectionMode: false,
              canWrite: true,
              spamAction: "junk",
              dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
            }}
            actions={{ navigate: () => {}, toggleSelection: () => {}, itemAction: () => {}, manageTags: () => {}, merge: () => {} }}
          />
        </>
      ),
      dom.root,
    );
    try {
      const data = new Map<string, string>();
      const row = dom.document.querySelector<HTMLElement>(".mail-list-row");
      expect(row?.getAttribute("draggable")).toBe("true");
      row!.dispatchEvent(dragEvent(dom.window, "dragstart", data));

      const target = dom.document.querySelector<HTMLElement>('a[href="/app/mail/Box001?folder=projects"]');
      expect(target).not.toBeNull();
      target!.dispatchEvent(dragEvent(dom.window, "drop", data));
      expect(moves).toEqual([{ itemId: "Msg002", destinationFolderId: "projects" }]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
