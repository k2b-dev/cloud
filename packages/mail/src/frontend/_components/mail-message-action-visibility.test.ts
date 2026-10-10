import { describe, expect, test } from "bun:test";
import { resolveMailMessageActionVisibility } from "./mail-message-action-visibility";

const base = {
  hasSender: true,
  hasMailingListUnsubscribe: true,
  hasConversation: true,
  totalMessageCount: 2,
  canWrite: true,
  canAdmin: true,
  mailboxWide: true,
};

describe("resolveMailMessageActionVisibility", () => {
  test("shows inbound sender actions and message reuse", () => {
    expect(resolveMailMessageActionVisibility({ ...base, outgoing: false })).toEqual({
      findSender: true,
      createIncomingAutomation: true,
      blockSender: true,
      manageUnsubscribe: true,
      conversationRepair: true,
      editAsNew: true,
      reportPhishing: true,
    });
  });

  test("hides every inbound sender action for an own outbound message", () => {
    expect(resolveMailMessageActionVisibility({ ...base, outgoing: true })).toEqual({
      findSender: false,
      createIncomingAutomation: false,
      blockSender: false,
      manageUnsubscribe: false,
      conversationRepair: true,
      editAsNew: true,
      reportPhishing: true,
    });
  });

  test("hides writes from readers while preserving sender search", () => {
    expect(
      resolveMailMessageActionVisibility({
        ...base,
        outgoing: false,
        canWrite: false,
        canAdmin: false,
      }),
    ).toEqual({
      findSender: true,
      createIncomingAutomation: false,
      blockSender: false,
      manageUnsubscribe: false,
      conversationRepair: false,
      editAsNew: false,
      reportPhishing: true,
    });
  });

  test("keeps a writer of assigned conversations to their conversations", () => {
    expect(resolveMailMessageActionVisibility({ ...base, outgoing: false, canAdmin: false, mailboxWide: false })).toEqual({
      findSender: true,
      createIncomingAutomation: false,
      blockSender: false,
      manageUnsubscribe: false,
      conversationRepair: false,
      editAsNew: false,
      reportPhishing: false,
    });
  });

  test("requires a multi-message conversation for repair actions", () => {
    const visibility = resolveMailMessageActionVisibility({
      ...base,
      outgoing: false,
      hasConversation: false,
    });
    expect(visibility.conversationRepair).toBe(false);
  });
});
