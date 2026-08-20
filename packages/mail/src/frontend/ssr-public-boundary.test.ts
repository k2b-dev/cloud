import { describe, expect, test } from "bun:test";
import type { MailAutomationAccessData } from "../service/automation-workspace";
import type { MailboxPageData, MailConversationDetailData } from "../service/workspace";
import {
  projectAutomationWorkspace,
  projectComposeData,
  projectMailboxPageData,
  projectMailConversationDetail,
  projectSsrFocusPage,
  projectSsrMailboxList,
  projectSsrPaths,
  resolveSsrMailboxId,
  resolveSsrMailboxResourceId,
  resolveSsrWorkspaceUrl,
} from "./ssr-public-boundary";

const ids = {
  mailbox: "00000000-0000-4000-8000-000000000001",
  conversation: "00000000-0000-4000-8000-000000000002",
  draft: "00000000-0000-4000-8000-000000000003",
  attachment: "00000000-0000-4000-8000-000000000004",
  automation: "00000000-0000-4000-8000-000000000005",
  folder: "00000000-0000-4000-8000-000000000006",
};
const shorts = new Map([
  [ids.mailbox, "Box001"],
  [ids.conversation, "Conv01"],
  [ids.draft, "Draft1"],
  [ids.attachment, "Attach"],
  [ids.automation, "Auto01"],
  [ids.folder, "Fold01"],
]);
const loadIds = async (_table: string, values: Array<string | null | undefined>) =>
  new Map(values.flatMap((id) => (id && shorts.has(id) ? [[id, shorts.get(id)!] as const] : [])));

describe("Mail SSR public boundary", () => {
  test("projects active and deleted overview mailbox IDs for browser links", async () => {
    const active = await projectSsrMailboxList([{ id: ids.mailbox, name: "Inbox" }], loadIds);
    const deleted = await projectSsrMailboxList([{ id: ids.mailbox, name: "Deleted" }], loadIds);

    expect(active[0]?.id).toBe("Box001");
    expect(deleted[0]?.id).toBe("Box001");
    expect(`/app/mail/${active[0]?.id}`).toBe("/app/mail/Box001");
    expect(JSON.stringify({ active, deleted })).not.toContain(ids.mailbox);

    const composeMailboxes = await projectSsrMailboxList([{ id: ids.mailbox, name: "Inbox" }], loadIds);
    expect(composeMailboxes).toEqual([{ id: "Box001", name: "Inbox" }]);
  });

  test("projects focus rows and mailbox counters through the same public boundary", async () => {
    const page = await projectSsrFocusPage(
      {
        items: [
          {
            id: ids.conversation,
            mailboxId: ids.mailbox,
            mailboxName: "Support",
            subject: "Release update",
            participantSummary: "Ada",
            latestMessageAt: "2026-08-19T10:00:00.000Z",
            workStatus: "needs_action" as const,
            assigneeUserId: null,
            unread: true,
            flagged: false,
            hasAttachments: false,
            preview: "Ready to ship",
          },
        ],
        counts: { mine: 0, unassigned: 1, waiting: 0, all: 1 },
        mailboxCounts: [{ mailboxId: ids.mailbox, unread: 1, needsAction: 1 }],
        nextCursor: null,
      },
      loadIds,
    );

    expect(page.items[0]).toMatchObject({ id: "Conv01", mailboxId: "Box001" });
    expect(page.mailboxCounts).toEqual([{ mailboxId: "Box001", unread: 1, needsAction: 1 }]);
    expect(JSON.stringify(page)).not.toContain(ids.mailbox);
  });

  test("loads distinct public-ID tables concurrently", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const projection = projectSsrPaths(
      { mailboxId: ids.mailbox, conversationId: ids.conversation },
      [
        { table: "mailboxes", segments: ["mailboxId"] },
        { table: "conversations", segments: ["conversationId"] },
      ],
      async (table, values) => {
        started.push(table);
        await gate;
        return new Map(values.map((id) => [id!, shorts.get(id!)!]));
      },
    );
    await Promise.resolve();
    expect(started).toEqual(["mailboxes", "conversations"]);
    release();
    await expect(projection).resolves.toEqual({ mailboxId: "Box001", conversationId: "Conv01" });
  });

  test("rejects legacy UUID route IDs before calling a resolver", async () => {
    let calls = 0;
    const resolve = async () => {
      calls += 1;
      return ids.mailbox;
    };
    expect(await resolveSsrMailboxId(ids.mailbox, resolve)).toBeNull();
    expect(await resolveSsrMailboxResourceId("drafts", ids.mailbox, ids.draft, resolve)).toBeNull();
    expect(calls).toBe(0);
  });

  test("projects workspace selection and nested list IDs", async () => {
    const data = {
      mailbox: { id: ids.mailbox },
      folders: [],
      identities: [],
      savedViewId: null,
      savedViews: [],
      folderId: null,
      selectedConversationId: ids.conversation,
      selectedMessageId: null,
      listItems: [
        {
          id: ids.conversation,
          conversationId: ids.conversation,
          selectionKind: "conversation",
          sourceFolderId: null,
          activeFolderIds: [],
          unreadFolderIds: [],
          localTags: [],
        },
      ],
      detailMessages: [],
      conversationDrafts: [],
      localTags: [],
      conversationLocalTags: null,
      comments: [],
      reminder: null,
      collaborationState: null,
      activity: [
        {
          conversationId: ids.conversation,
          targetType: "conversation",
          targetId: ids.conversation,
          metadata: { conversationId: ids.conversation },
        },
      ],
      scheduledPage: null,
    } as unknown as MailboxPageData;
    const projected = await projectMailboxPageData(data, loadIds);
    expect(projected.mailbox.id).toBe("Box001");
    expect(projected.selectedConversationId).toBe("Conv01");
    expect(projected.listItems[0]).toMatchObject({ id: "Conv01", conversationId: "Conv01" });
    expect(projected.activity[0]).toMatchObject({
      conversationId: "Conv01",
      targetId: "Conv01",
      metadata: { conversationId: "Conv01" },
    });
  });

  test("projects an SSR focus detail before hydration", async () => {
    const data = {
      conversationId: ids.conversation,
      detailMessages: [],
      conversationDrafts: [],
      localTags: [],
      conversationLocalTags: null,
      comments: [],
      reminder: null,
      collaborationState: { conversationId: ids.conversation },
      activity: [
        {
          conversationId: ids.conversation,
          targetType: "conversation",
          targetId: ids.conversation,
          metadata: { conversationId: ids.conversation },
        },
      ],
    } as unknown as MailConversationDetailData;

    const projected = await projectMailConversationDetail(data, loadIds);
    expect(projected.conversationId).toBe("Conv01");
    expect(projected.collaborationState?.conversationId).toBe("Conv01");
    expect(projected.activity[0]).toMatchObject({ conversationId: "Conv01", targetId: "Conv01" });
  });

  test("resolves short workspace URL state without changing the public URL", async () => {
    const publicUrl = new URL(
      'https://cloud.test/app/mail/Box001?conversation=Conv01&search={"expression":{"type":"and","expressions":[{"type":"folder_id","folderId":"Fold01"},{"type":"local_tag_id","tagId":"Tag001"}]},"sort":"newest"}',
    );
    const resolved = await resolveSsrWorkspaceUrl(publicUrl, ids.mailbox, async (table, _mailboxId, values) =>
      values.map((value) =>
        table === "conversations" && value === "Conv01"
          ? ids.conversation
          : table === "tags"
            ? "00000000-0000-4000-8000-000000000007"
            : "00000000-0000-4000-8000-000000000006",
      ),
    );
    expect(publicUrl.searchParams.get("conversation")).toBe("Conv01");
    expect(resolved?.searchParams.get("conversation")).toBe(ids.conversation);
    expect(resolved?.searchParams.get("search")).toContain("00000000-0000-4000-8000-000000000006");
    expect(resolved?.searchParams.get("search")).toContain("00000000-0000-4000-8000-000000000007");
  });

  test("projects automation roots without touching technical workflow IDs", async () => {
    const workflowId = "00000000-0000-4000-8000-000000000099";
    const data = {
      mailbox: { id: ids.mailbox },
      permission: "admin",
      incomingAutomations: [
        {
          id: ids.automation,
          mailboxId: ids.mailbox,
          workflowId,
          steps: [{ id: workflowId, kind: "mail_action", action: { kind: "move_to_folder", folderId: ids.folder } }],
        },
      ],
      recentActivity: [{ href: `/app/mail/${ids.mailbox}/automations/incoming` }],
    } as unknown as MailAutomationAccessData & {
      incomingAutomations: Array<{ id: string; mailboxId: string; workflowId: string; steps: unknown[] }>;
      recentActivity: Array<{ href: string }>;
    };
    const projected = await projectAutomationWorkspace(data, loadIds);
    expect(projected.mailbox.id).toBe("Box001");
    expect(projected.incomingAutomations[0]).toMatchObject({
      id: "Auto01",
      mailboxId: "Box001",
      workflowId,
      steps: [{ id: workflowId, action: { folderId: "Fold01" } }],
    });
    expect(projected.recentActivity[0]?.href).toBe("/app/mail/Box001/automations/incoming");
  });

  test("projects compose mailbox, draft and nested attachment IDs", async () => {
    const data = {
      mailbox: { id: ids.mailbox },
      identities: [],
      draft: {
        id: ids.draft,
        conversationId: ids.conversation,
        derivedFromMessageId: null,
        senderIdentityId: null,
        attachments: [{ id: ids.attachment }],
      },
    };
    const projected = await projectComposeData(data, loadIds);
    expect(projected).toMatchObject({
      mailbox: { id: "Box001" },
      draft: { id: "Draft1", conversationId: "Conv01", attachments: [{ id: "Attach" }] },
    });
  });
});
