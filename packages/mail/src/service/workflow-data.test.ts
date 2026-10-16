import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { MailWorkflowTargetSnapshot } from "./workflow-data";
import { getWorkflowSnapshot, getWorkflowSnapshots, mailWorkflowEventContext, normalizeWorkflowKeywords } from "./workflow-data";
import { mailWorkflowMessagePrecondition } from "./workflow-message-preconditions";

describe("Mail workflow event context", () => {
  test("freezes only keywords the remote precondition can express", () => {
    const target = { messageId: "message", remoteMessageRefId: "remote", folderId: "folder" };
    const keywords = normalizeWorkflowKeywords(["\\Inbox", "\\Important", " review ", "needs action", "", "zebra", "a".repeat(101)]);
    expect(keywords).toEqual(["review", "zebra"]);
    expect(
      mailWorkflowMessagePrecondition(
        {
          preconditions: {
            message: { id: target.messageId, remoteMessageRefId: target.remoteMessageRefId, folderId: target.folderId },
            remoteState: { modseq: "42", flags: ["seen"], keywords },
          },
        },
        target,
      ),
    ).toEqual({ modseq: "42", flags: ["seen"], keywords: ["review", "zebra"] });
  });

  test("freezes source data and receipt-time preconditions into the kernel event", () => {
    const snapshot = {
      targetKey: "remote-message",
      mailboxShortId: "mail01",
      source: {
        message: { id: "msg001" },
        conversation: null,
      },
      preconditions: {
        sourceHash: "source-hash",
        message: { id: "message-uuid", remoteMessageRefId: "remote-message", folderId: "folder-uuid" },
        remoteState: { modseq: "42", flags: ["seen"], keywords: ["review"] },
        conversation: { id: "conversation-uuid", revision: 3, linkView: { snapshot: "10:20:11,15", xid: "19", seq: "42" } },
        triggerKind: "messageReceived",
      },
      internalDate: "2026-07-26T12:00:00.000Z",
    } as unknown as MailWorkflowTargetSnapshot;

    const context = mailWorkflowEventContext(snapshot);
    expect(context).toEqual({
      mailboxId: "mail01",
      source: snapshot.source,
      preconditions: snapshot.preconditions,
    });
    expect((context.source as { message: Record<string, unknown> }).message).not.toHaveProperty("messageId");
  });
});

// Test the row-to-context boundary for both point reads and batch reads, without a database.
test("snapshot readers preserve the view's own xid and link order with its revision", async () => {
  for (const xid of [null, "9007199254740993"]) {
    const row = {
      remote_message_ref_id: "remote",
      message_id: "message",
      message_short_id: "msg001",
      conversation_id: "conversation",
      conversation_short_id: "conv001",
      mailbox_short_id: "mail01",
      subject: "Snapshot",
      plain_text: null,
      sanitized_html: null,
      hydration_status: "envelope",
      sender: [],
      recipients: [],
      attachments: [],
      internal_date: "2026-10-01T08:00:00.000Z",
      sent_at: null,
      protocol_facts: {},
      folder_id: "folder",
      folder_short_id: "fld001",
      modseq: null,
      flags: [],
      keywords: [],
      direction: "inbound",
      conversation_subject: "Snapshot",
      conversation_summary: null,
      summary_revision: "1",
      collaboration_revision: "3",
      assignee_user_ids: [],
      work_status: "needs_action",
      latest_message_at: "2026-10-01T08:00:00.000Z",
      link_snapshot: "10:20:11,15",
      link_xid: xid,
      link_seq: "9007199254740994",
    };
    const db = new Proxy(sql, { apply: () => Promise.resolve([row]) });
    const point = await getWorkflowSnapshot({ db, mailboxId: "mailbox", remoteMessageRefId: "remote" });
    const batch = await getWorkflowSnapshots({ db, mailboxId: "mailbox", remoteMessageRefIds: ["remote"] });
    for (const snapshot of [point, batch.get("remote")]) {
      expect(snapshot?.preconditions.conversation).toEqual({
        id: "conversation",
        revision: 3,
        linkView: { snapshot: "10:20:11,15", xid, seq: "9007199254740994" },
      });
    }
  }
});
