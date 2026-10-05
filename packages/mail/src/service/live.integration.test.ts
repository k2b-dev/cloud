import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { MailLiveEventSchema } from "../live-events";
import { migrate } from "../migrate";
import { enqueueMailInvalidation, mailLive } from "./live";

type Pending = { payload: { v: number; k: string; d: unknown } };

// Publishing and serving the rows is covered by the platform's live tests; this file checks what Mail writes.
const suite = suiteFor("database", "nats");

suite("Mail live updates", () => {
  const mailboxId = crypto.randomUUID();
  const mailboxShortId = newShortId();
  const conversations = [
    { id: crypto.randomUUID(), shortId: newShortId() },
    { id: crypto.randomUUID(), shortId: newShortId() },
  ] as const;

  beforeAll(async () => {
    await migrate();
    await sql`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailboxId}::uuid, ${mailboxShortId}, 'Live updates')`;
    for (const conversation of conversations) {
      await sql`
        INSERT INTO mail.conversations (id, short_id, mailbox_id, latest_message_at)
        VALUES (${conversation.id}::uuid, ${conversation.shortId}, ${mailboxId}::uuid, now())
      `;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key = ${mailboxId}`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
  });

  const pending = async () => {
    const rows = await sql<Pending[]>`
      SELECT payload FROM events.outbox WHERE app_id = 'mail' AND kind = 'live' AND ordering_key = ${mailboxId} ORDER BY seq
    `;
    await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key = ${mailboxId}`;
    return rows.map((row) => row.payload);
  };

  const activity = (tx: typeof sql, action: string, conversationId: string | null) => tx`
    INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, action, outcome)
    VALUES (${mailboxId}::uuid, ${conversationId}::uuid, 'system', ${action}, 'confirmed')
  `;

  test("a transaction writes one update per conversation it touched and one for the mailbox, in the order it touched them", async () => {
    const [first, second] = conversations;
    await sql.begin(async (tx) => {
      await activity(tx, "test.first", first.id);
      await activity(tx, "test.mailbox", null);
      await activity(tx, "test.second", second.id);
      await activity(tx, "test.first-again", first.id);
      await enqueueMailInvalidation(tx, { mailboxId, conversationId: second.id });
      await enqueueMailInvalidation(tx, { mailboxId });
    });
    const updates = await pending();
    expect(updates.map((update) => update.d)).toEqual([
      { conversationId: first.shortId },
      { conversationId: null },
      { conversationId: second.shortId },
    ]);
    for (const update of updates) expect(MailLiveEventSchema.parse(update.d)).toEqual(update.d as never);

    // Another transaction writes its own updates.
    await sql.begin((tx) => activity(tx, "test.later", first.id));
    expect((await pending()).map((update) => update.d)).toEqual([{ conversationId: first.shortId }]);
  });

  test("a rolled back change writes nothing", async () => {
    await expect(
      sql.begin(async (tx) => {
        await activity(tx, "test.rolled-back", conversations[0].id);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await pending()).toEqual([]);
  });

  test("an update keyed by the mailbox has the form the platform publishes", async () => {
    await sql.begin(async (tx) => {
      await enqueueMailInvalidation(tx, { mailboxId, conversationId: conversations[0].id });
      await mailLive.publish(tx, { key: mailboxId, data: { conversationId: conversations[0].shortId } });
    });
    const [fromSql, fromPublish] = await pending();
    expect(fromSql).toEqual(fromPublish!);
    expect(fromSql).toEqual({ v: 1, k: mailboxId, d: { conversationId: conversations[0].shortId } });
  });

  test("a conversation of another mailbox counts as a change of the whole mailbox", async () => {
    await sql.begin((tx) => enqueueMailInvalidation(tx, { mailboxId, conversationId: crypto.randomUUID() }));
    expect((await pending()).map((update) => update.d)).toEqual([{ conversationId: null }]);
  });
});
