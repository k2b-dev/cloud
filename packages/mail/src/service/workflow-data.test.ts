import { describe, expect, test } from "bun:test";
import type { MailWorkflowTargetSnapshot } from "./workflow-data";
import { mailWorkflowEventContext, normalizeWorkflowKeywords } from "./workflow-data";
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
        conversation: { id: "conversation-uuid", revision: 3, linkSnapshot: "10:20:11,15" },
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
