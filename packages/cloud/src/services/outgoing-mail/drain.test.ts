import { expect, mock, spyOn, test } from "bun:test";
import * as dispatcher from "./dispatcher";
import * as drain from "./drain";
import type { MessageRow } from "./messages";

const row: MessageRow = {
  id: crypto.randomUUID(),
  app_id: "inventory",
  profile_id: crypto.randomUUID(),
  profile_key: "alerts",
  batch_id: crypto.randomUUID(),
  ref_scope: null,
  ref_id: null,
  to_addresses: ["reader@example.org"],
  recipient_count: 1,
  subject: "Hello",
  text_body: "Hello",
  html_body: null,
  headers: null,
  from_name: null,
  reply_to: null,
  message_id_header: "<bulk@example.org>",
  attachments: [],
  attachment_refs: [],
  status: "sending",
  error_code: null,
  error_message: null,
  smtp_response: null,
  failures: [],
  attempt_count: 1,
  next_attempt_at: null,
  deadline_at: new Date(Date.now() + 24 * 60 * 60_000),
  actor_type: null,
  actor_id: null,
  actor_name: null,
  created_at: new Date(),
  cursor_created_at: new Date().toISOString(),
  sent_at: null,
  content_purged_at: null,
};

test("the run window stops new claims, lets the current attempt finish, and heartbeats afterward", async () => {
  const started = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(started);
  const shutdown = new AbortController();
  const heartbeat = mock(async () => {});
  const claim = spyOn(drain, "claimOutgoingBulkMail").mockResolvedValue({ row, slotAt: "unused", grantedAt: "unused" });
  const next = spyOn(drain, "nextOutgoingBulkDelay").mockResolvedValue(30_000);
  const attempt = spyOn(dispatcher, "attemptOutgoingMail").mockImplementation(async (claimed, signal) => {
    expect(claimed).toBe(row);
    expect(signal).toBe(shutdown.signal);
    clock.mockReturnValue(started + drain.MAIL_DRAIN_MS);
    await Bun.sleep(1);
    expect(signal?.aborted).toBe(false);
    expect(heartbeat).not.toHaveBeenCalled();
  });
  try {
    expect(await drain.drainOutgoingMail(row.profile_id!, shutdown.signal, heartbeat)).toBe(30_000);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  } finally {
    attempt.mockRestore();
    next.mockRestore();
    claim.mockRestore();
    clock.mockRestore();
  }
});

test("shutdown reaches the in-flight attempt and prevents subsequent claims", async () => {
  const shutdown = new AbortController();
  const heartbeat = mock(async () => {});
  const claim = spyOn(drain, "claimOutgoingBulkMail").mockResolvedValue({ row, slotAt: "unused", grantedAt: "unused" });
  const next = spyOn(drain, "nextOutgoingBulkDelay").mockResolvedValue(30_000);
  const attempt = spyOn(dispatcher, "attemptOutgoingMail").mockImplementation(async (_, signal) => {
    shutdown.abort();
    expect(signal?.aborted).toBe(true);
  });
  try {
    await drain.drainOutgoingMail(row.profile_id!, shutdown.signal, heartbeat);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await drain.drainOutgoingMail(row.profile_id!, shutdown.signal, heartbeat);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  } finally {
    attempt.mockRestore();
    next.mockRestore();
    claim.mockRestore();
  }
});
