import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import {
  claimMailInvalidationBatch,
  dispatchMailInvalidation,
  enqueueMailInvalidation,
  latestMailInvalidationCursor,
  liveMailInvalidations,
  notifyMailInvalidations,
} from "./events";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("Mail live invalidation outbox", () => {
  const mailboxId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const mailboxShortId = "Box001";
  const conversationShortId = "Conv01";

  beforeAll(async () => {
    await migrate();
    await sql`
      INSERT INTO mail.mailboxes (id, short_id, name)
      VALUES (${mailboxId}::uuid, ${mailboxShortId}, 'Live invalidation test')
    `;
    await sql`
      INSERT INTO mail.conversations (id, short_id, mailbox_id, latest_message_at)
      VALUES (${conversationId}::uuid, ${conversationShortId}, ${mailboxId}::uuid, now())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
  });

  test("coalesces activity writes in one transaction and publishes one invalidation", async () => {
    const cursor = await latestMailInvalidationCursor(mailboxId);
    const aborts = [new AbortController(), new AbortController()];
    const pendingEvents = aborts.map((abort) =>
      liveMailInvalidations({ mailboxId, after: cursor, signal: abort.signal })[Symbol.asyncIterator]().next(),
    );

    await sql.begin(async (tx) => {
      for (const action of ["test.first", "test.second"]) {
        await tx`
          INSERT INTO mail.activity_events (
            mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id
          ) VALUES (
            ${mailboxId}::uuid,
            ${conversationId}::uuid,
            'system',
            ${action},
            'confirmed',
            'conversation',
            ${conversationId}::uuid
          )
        `;
      }
    });

    const [queued] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM mail.live_invalidation_outbox
      WHERE mailbox_id = ${mailboxId}::uuid AND delivered_at IS NULL
    `;
    expect(queued?.count).toBe(1);

    await sql`DELETE FROM mail.conversations WHERE id = ${conversationId}::uuid`;
    await notifyMailInvalidations();
    const events = await Promise.all(
      pendingEvents.map((pendingEvent) =>
        Promise.race([
          pendingEvent,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Mail invalidation")), 5_000)),
        ]),
      ),
    );
    for (const abort of aborts) abort.abort();
    const changeIds = events.map((event) => event.value?.data.changeId);
    for (const event of events) {
      expect(event.done).toBe(false);
      expect(event.value?.data.type).toBe("mail.invalidated");
      expect(event.value?.data.mailboxId).toBe(mailboxShortId);
      expect(event.value?.data.conversationId).toBe(conversationShortId);
      expect(event.value?.data.changeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number.isFinite(Date.parse(event.value!.data.at))).toBe(true);
    }
    expect(changeIds[0]).toBe(changeIds[1]);
  });

  test("retries the same durable invalidation after publication fails", async () => {
    const outboxId = await sql.begin((tx) => enqueueMailInvalidation(tx, { mailboxId }));
    const claimed = await claimMailInvalidationBatch();
    const row = claimed.find((candidate) => candidate.id === outboxId);
    expect(row).toBeDefined();
    if (!row) return;

    await dispatchMailInvalidation(row, async () => {
      throw new Error("topic unavailable");
    });
    const [failed] = await sql<{ attempts: number; delivered_at: Date | null }[]>`
      SELECT attempts, delivered_at
      FROM mail.live_invalidation_outbox
      WHERE id = ${outboxId}::uuid
    `;
    expect(failed).toMatchObject({ attempts: 1, delivered_at: null });

    await sql`
      UPDATE mail.live_invalidation_outbox
      SET next_attempt_at = now()
      WHERE id = ${outboxId}::uuid
    `;
    const retried = (await claimMailInvalidationBatch()).find((candidate) => candidate.id === outboxId);
    expect(retried).toBeDefined();
    if (!retried) return;
    const published: string[] = [];
    await dispatchMailInvalidation(retried, async (candidate) => published.push(candidate.id));
    expect(published).toEqual([outboxId]);

    const [delivered] = await sql<{ attempts: number; delivered_at: Date | null }[]>`
      SELECT attempts, delivered_at
      FROM mail.live_invalidation_outbox
      WHERE id = ${outboxId}::uuid
    `;
    expect(delivered?.attempts).toBe(1);
    expect(delivered?.delivered_at).not.toBeNull();
  });
});
