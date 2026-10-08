import { expect, spyOn, test } from "bun:test";
import * as store from "@k2b/cloud/services/outgoing-mail/store";
import * as imap from "./imap";
import * as poller from "./poller";
import { BOUNCE_ACK_WAIT_MS, BOUNCE_RUN_BUDGET_MS, pollOutgoingMailBounces } from "./runtime";

const profile: store.ImapMailProfile = {
  id: crypto.randomUUID(),
  key: "sender",
  revision: 1,
  fromAddress: "sender@example.org",
  imap: { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX", hasPassword: false },
  uidValidity: null,
  lastUid: null,
};
test("without enabled profiles no mailbox is created or polled", async () => {
  const list = spyOn(store, "listImapMailProfiles").mockResolvedValue([]);
  const connect = spyOn(imap, "createImapBounceMailbox");
  const poll = spyOn(poller, "pollProfileBounces").mockResolvedValue();
  try {
    await pollOutgoingMailBounces(new AbortController().signal);
    expect(list).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  } finally {
    list.mockRestore();
    connect.mockRestore();
    poll.mockRestore();
  }
});
test("enabled profiles run sequentially within four minutes; leftovers wait when aborted", async () => {
  const list = spyOn(store, "listImapMailProfiles").mockResolvedValue([
    profile,
    { ...profile, key: "second" },
    { ...profile, key: "third" },
  ]);
  const controller = new AbortController();
  const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const seen: string[] = [];
  let active = false;
  const connect = spyOn(imap, "createImapBounceMailbox").mockReturnValue({
    open: async () => ({ uidValidity: "42" }),
    listUids: async () => ({ uids: [], through: 0 }),
    bodyStructure: async () => null,
    fetchPart: async () => null,
    close: () => {},
  });
  const poll = spyOn(poller, "pollProfileBounces").mockImplementation(async (item, mailbox, signal) => {
    mailbox();
    expect(active).toBe(false);
    active = true;
    await Promise.resolve();
    seen.push(item.key);
    active = false;
    if (item.key === "second") controller.abort();
    expect(signal.aborted).toBe(item.key === "second");
  });
  try {
    await pollOutgoingMailBounces(new AbortController().signal);
    expect(deadline.mock.calls).toEqual([[240_000]]);
    expect(seen).toEqual(["sender", "second"]);
    expect(connect).toHaveBeenCalledTimes(2);
    await pollOutgoingMailBounces(AbortSignal.abort());
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    list.mockRestore();
    deadline.mockRestore();
    connect.mockRestore();
    poll.mockRestore();
  }
});

test("the processing budget also interrupts profile loading", async () => {
  const controller = new AbortController();
  const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const list = spyOn(store, "listImapMailProfiles").mockImplementation(async () => {
    controller.abort();
    return new Promise(() => {});
  });
  const connect = spyOn(imap, "createImapBounceMailbox");
  try {
    await pollOutgoingMailBounces(new AbortController().signal);
    expect(connect).not.toHaveBeenCalled();
  } finally {
    deadline.mockRestore();
    list.mockRestore();
    connect.mockRestore();
  }
});

test("scheduler lease exceeds the bounded run plus error write", () => {
  expect(BOUNCE_ACK_WAIT_MS).toBeGreaterThan(BOUNCE_RUN_BUDGET_MS + poller.BOUNCE_ERROR_WRITE_BUDGET_MS);
  expect(BOUNCE_ACK_WAIT_MS).toBe(300_000);
});
