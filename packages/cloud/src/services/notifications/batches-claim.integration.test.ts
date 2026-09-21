import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { toPgTextArray, toPgUuidArray } from "../postgres";
import { __notificationBatchTest } from "./batches";

const suite = databaseSuite();

/**
 * Recipients are claimed with `FOR UPDATE SKIP LOCKED`, so two workers that
 * process the same batch at once must partition the recipients instead of
 * sending to anyone twice. Email transport is not configured in the test
 * database, so every claimed recipient ends in `error` — the claim, not the
 * send, is under test.
 */
suite("notification batch recipient claims", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let batchId = "";

  beforeAll(async () => {
    const uids = Array.from({ length: 150 }, (_, index) => `batch-claim-${suffix}-${index}`);
    const mails = uids.map((uid) => `${uid}@example.test`);
    const users = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
      SELECT uid, 'local', 'user', 'Batch recipient', mail, 'Batch', 'Recipient'
      FROM unnest(${toPgTextArray(uids)}::text[], ${toPgTextArray(mails)}::text[]) AS candidate(uid, mail)
      RETURNING id
    `;
    userIds.push(...users.map((user) => user.id));
    const [batch] = await sql<{ id: string }[]>`
      INSERT INTO notifications.batches (subject, body_markdown, body_html, selection, selection_hash, status, target_count, deliverable_count)
      VALUES ('Claim contract', 'body', '<p>body</p>', ${JSON.stringify({ userIds })}::jsonb, ${suffix}, 'ready', ${userIds.length}, ${userIds.length})
      RETURNING id
    `;
    if (!batch) throw new Error("fixture batch was not created");
    batchId = batch.id;
    await sql`
      INSERT INTO notifications.batch_recipients (batch_id, user_id, recipient, uid, display_name, provider, profile)
      SELECT ${batchId}::uuid, user_id, mail, uid, 'Batch recipient', 'local', 'user'
      FROM unnest(${toPgUuidArray(userIds)}::uuid[], ${toPgTextArray(mails)}::text[], ${toPgTextArray(uids)}::text[]) AS candidate(user_id, mail, uid)
    `;
  }, 30_000);
  afterAll(async () => {
    if (batchId) await sql`DELETE FROM notifications.batches WHERE id = ${batchId}::uuid`;
    await sql`DELETE FROM auth.users WHERE uid LIKE ${`batch-claim-${suffix}-%`}`;
  });

  test("two concurrent workers claim every recipient exactly once", async () => {
    const claim = __notificationBatchTest.processBatchChunk;
    const [first, second] = await Promise.all([claim(batchId), claim(batchId)]);
    expect(first.processed + second.processed).toBe(userIds.length);
    const recipients = await sql<{ user_id: string; attempt_count: number; status: string }[]>`
      SELECT user_id, attempt_count, status FROM notifications.batch_recipients WHERE batch_id = ${batchId}::uuid
    `;
    expect(recipients).toHaveLength(userIds.length);
    expect(recipients.every((recipient) => recipient.attempt_count === 1)).toBe(true);
    expect(recipients.every((recipient) => recipient.status !== "pending")).toBe(true);
    expect(new Set(recipients.map((recipient) => recipient.user_id)).size).toBe(userIds.length);
  }, 60_000);
});
