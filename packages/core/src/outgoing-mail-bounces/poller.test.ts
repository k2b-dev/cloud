import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as logging from "@k2b/cloud/services/logging";
import * as messages from "@k2b/cloud/services/outgoing-mail/messages";
import * as store from "@k2b/cloud/services/outgoing-mail/store";
import { headers, report, status, structure } from "./fixtures";
import { DSN_PART_BYTES } from "./parser";
import { type BounceMailbox, pollProfileBounces } from "./poller";

const profile: store.ImapMailProfile = {
  id: "01234567-89ab-4def-8012-3456789abcde",
  key: "sender",
  revision: 1,
  fromAddress: "sender@example.org",
  imap: { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX", hasPassword: true },
  uidValidity: "42",
  lastUid: 10,
};
const mailbox = (uids = [11, 12]) =>
  ({
    open: mock(async (_folder: string, _options: { readOnly: true }) => ({ uidValidity: "42" })),
    listUids: mock(async (_query: { after?: number; since?: Date; limit: number }) => uids),
    bodyStructure: mock(async (_uid: number) => structure),
    fetchPart: mock(async (_uid: number, part: string, _maxBytes: number) => Buffer.from(part === "2" ? status : headers)),
    close: mock(() => {}),
  }) satisfies BounceMailbox;
let saved: ReturnType<typeof spyOn<typeof store, "saveImapMailCheck">>;
let applied: ReturnType<typeof spyOn<typeof messages, "applyOutgoingMailBounce">>;
let logger: ReturnType<typeof spyOn<typeof logging, "logger">>;
const errors = mock(() => {});
beforeEach(() => {
  errors.mockClear();
  saved = spyOn(store, "saveImapMailCheck").mockResolvedValue();
  applied = spyOn(messages, "applyOutgoingMailBounce").mockResolvedValue();
  logger = spyOn(logging, "logger").mockReturnValue({ error: errors, warn: mock(() => {}), debug: mock(() => {}), info: mock(() => {}) });
});
afterEach(() => {
  saved.mockRestore();
  applied.mockRestore();
  logger.mockRestore();
});
test("read-only poll matches reports, processes ascending UIDs strictly above the cursor, and advances with CAS", async () => {
  const box = mailbox([12, 10, 11, 12]);
  await pollProfileBounces(profile, box, new AbortController().signal);
  expect(box.open.mock.calls).toEqual([["INBOX", { readOnly: true }]]);
  expect(box.listUids.mock.calls).toEqual([[{ after: 10, limit: 200 }]]);
  expect(box.bodyStructure.mock.calls).toEqual([[11], [12]]);
  expect(box.fetchPart.mock.calls).toEqual([
    [11, "2", DSN_PART_BYTES],
    [11, "3.HEADER", DSN_PART_BYTES],
    [12, "2", DSN_PART_BYTES],
    [12, "3.HEADER", DSN_PART_BYTES],
  ]);
  expect(applied.mock.calls).toEqual([
    [profile.id, report.messageId, report.failures],
    [profile.id, report.messageId, report.failures],
  ]);
  expect(saved.mock.calls).toEqual([[profile, { uidValidity: "42", lastUid: 12 }]]);
  expect(Object.keys(box).sort()).toEqual(["open", "listUids", "bodyStructure", "fetchPart", "close"].sort());
  expect(box.close).toHaveBeenCalledTimes(1);
});
test.each([null, "previous"])("first run or UIDVALIDITY change %s restarts in the last seven days", async (uidValidity) => {
  const box = mailbox([2]);
  const started = Date.now();
  await pollProfileBounces({ ...profile, uidValidity, lastUid: 900 }, box, new AbortController().signal);
  const query = box.listUids.mock.calls[0]?.[0];
  expect(query).toMatchObject({ limit: 200 });
  expect(query).not.toHaveProperty("after");
  const expected = started - 7 * 24 * 60 * 60_000;
  expect(query?.since?.getTime()).toBeGreaterThanOrEqual(expected);
  expect(query?.since?.getTime()).toBeLessThan(expected + 1000);
  expect(saved.mock.calls[0]?.[1]).toEqual({ uidValidity: "42", lastUid: 2 });
});
test("at most 200 messages are processed and the remainder is picked up next run", async () => {
  const box = mailbox(Array.from({ length: 205 }, (_, i) => i + 11));
  await pollProfileBounces(profile, box, new AbortController().signal);
  expect(box.bodyStructure).toHaveBeenCalledTimes(200);
  expect(saved.mock.calls[0]?.[1]).toEqual({ uidValidity: "42", lastUid: 210 });
  box.bodyStructure.mockClear();
  await pollProfileBounces({ ...profile, lastUid: 210 }, box, new AbortController().signal);
  expect(box.bodyStructure.mock.calls.map(([uid]) => uid)).toEqual([211, 212, 213, 214, 215]);
});
test("empty reset saves new UIDVALIDITY with a null cursor; empty normal poll preserves it", async () => {
  await pollProfileBounces({ ...profile, uidValidity: null }, mailbox([]), new AbortController().signal);
  expect(saved.mock.calls[0]?.[1]).toEqual({ uidValidity: "42", lastUid: null });
  await pollProfileBounces(profile, mailbox([]), new AbortController().signal);
  expect(saved.mock.calls[1]?.[1]).toEqual({ uidValidity: "42", lastUid: 10 });
});
test("non-DSNs, foreign IDs and oversized parts advance without applying a bounce", async () => {
  const box: BounceMailbox = { ...mailbox(), bodyStructure: mock(async () => ({ type: "text/plain" })) };
  await pollProfileBounces(profile, box, new AbortController().signal);
  expect(applied).not.toHaveBeenCalled();
  const big: BounceMailbox = { ...mailbox(), fetchPart: mock(async () => Buffer.alloc(DSN_PART_BYTES + 1)) };
  await pollProfileBounces(profile, big, new AbortController().signal);
  await pollProfileBounces({ ...profile, fromAddress: "other@foreign.org" }, mailbox(), new AbortController().signal);
  expect(applied).not.toHaveBeenCalled();
});
test("error stores a short credential-free status, keeps the old cursor, logs once and closes", async () => {
  const box = mailbox();
  box.bodyStructure.mockRejectedValue(new Error("password=must-not-escape"));
  await pollProfileBounces(profile, box, new AbortController().signal);
  expect(saved.mock.calls).toEqual([[profile, { error: "Could not read delivery report. Check the IMAP connection and configuration." }]]);
  expect(errors).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([saved.mock.calls, errors.mock.calls])).not.toContain("must-not-escape");
  expect(box.close).toHaveBeenCalledTimes(1);
});
test("abort interrupts a pending operation, preserves the cursor and closes", async () => {
  const box = mailbox();
  const controller = new AbortController();
  box.open.mockImplementation(async () => {
    controller.abort();
    return new Promise(() => {});
  });
  await pollProfileBounces(profile, box, controller.signal);
  expect(saved.mock.calls).toEqual([[profile, { error: "Bounce polling interrupted." }]]);
  expect(box.listUids).not.toHaveBeenCalled();
  expect(box.close).toHaveBeenCalledTimes(1);
});

test("a mailbox with no initial recent mail keeps the seven-day window until a cursor exists", async () => {
  const box = mailbox([]);
  await pollProfileBounces({ ...profile, lastUid: null }, box, new AbortController().signal);
  expect(box.listUids.mock.calls[0]?.[0]).toHaveProperty("since");
  expect(box.listUids.mock.calls[0]?.[0]).not.toHaveProperty("after");
});

test("abort interrupts a pending database effect without advancing the cursor", async () => {
  const controller = new AbortController();
  applied.mockImplementation(async () => {
    controller.abort();
    return new Promise(() => {});
  });
  const box = mailbox([11]);
  await pollProfileBounces(profile, box, controller.signal);
  expect(saved.mock.calls).toEqual([[profile, { error: "Bounce polling interrupted." }]]);
  expect(box.close).toHaveBeenCalledTimes(1);
});
