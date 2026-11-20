import { afterAll, beforeAll, expect, test } from "bun:test";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";

const database = testInfra.database ? await useMigratedDatabase("task_messages_shape") : null;
const { sql } = await import("../runtime/clients");
const { migrateCloudAi } = await import("./migrate");
const { aiConversations } = await import("./store");
afterAll(async () => {
  await database?.drop();
});

// ai.task_messages is created once with LIKE ai.messages (c8e6ac6dee, 2026-09-20) and both are read
// together, by older images with SELECT * in a UNION. These are the columns both had then; every
// later ai.messages column must reach ai.task_messages through the startup migration, in the same order.
const firstTaskMessagesColumns = [
  "id",
  "conversation_id",
  "seq",
  "kind",
  "role",
  "message",
  "model_profile_id",
  "provider_model",
  "usage",
  "stop_reason",
  "loop_id",
  "loop_aggregate",
  "loop_done_reason",
  "compacted_at",
  "created_at",
  "short_id",
  "meta",
  "feedback_rating",
  "feedback_reasons",
  "feedback_comment",
  "feedback_updated_at",
  "search_text",
  "search_document",
];
const delegated = ["delegated_source_turn_id", "delegated_target_turn_id", "delegated_send_receipt_id"];

const columns = async (table: "messages" | "task_messages") =>
  (
    await sql<{ name: string; type: string }[]>`
      SELECT attname AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = ${`ai.${table}`}::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`
  ).map(({ name, type }) => `${name} ${type}`);

const dropColumns = async (table: "messages" | "task_messages", names: string[]) => {
  // A test-only rewind to an older installation; dependent indexes go with their column, as before it existed.
  for (const name of names) await sql.unsafe(`ALTER TABLE ai.${table} DROP COLUMN IF EXISTS ${name} CASCADE`);
};

let conversationId: string;
const archivedTurnId = "44444444-4444-4444-8444-444444444444";
const liveTurnId = "55555555-5555-4555-8555-555555555555";

databaseSuite()("ai.task_messages keeps the shape of ai.messages across upgrades", () => {
  beforeAll(async () => {
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, mail)
      VALUES ('task-messages-shape-owner', 'local', 'user', 'shape@example.test') RETURNING id`;
    conversationId = (await aiConversations.createConversation({ ownerUserId: owner!.id })).id;
    const message = JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Kept" }] });
    await sql.begin(async (db) => {
      // Archived run history is read-only; only this private fixture writes one row before reading.
      await db`ALTER TABLE ai.task_messages DISABLE TRIGGER ai_routine_archive_read_only`;
      await db`INSERT INTO ai.task_messages(short_id, conversation_id, seq, kind, role, message, loop_id)
        VALUES (${testShortId()}, ${conversationId}::uuid, 1, 'message', 'assistant', ${message}::text::jsonb, ${archivedTurnId})`;
      await db`ALTER TABLE ai.task_messages ENABLE TRIGGER ai_routine_archive_read_only`;
    });
    await sql`INSERT INTO ai.messages(short_id, conversation_id, seq, kind, role, message, loop_id)
      VALUES (${testShortId()}, ${conversationId}::uuid, 1, 'message', 'assistant', ${message}::text::jsonb, ${liveTurnId})`;
  });

  const upgrades: [string, () => Promise<void>][] = [
    ["a fresh startup", async () => {}],
    [
      "task_messages as first created, before every later ai.messages column",
      async () => {
        const later = (await columns("messages"))
          .map((column) => column.split(" ")[0]!)
          .filter((name) => !firstTaskMessagesColumns.includes(name));
        await dropColumns("messages", later);
        await dropColumns("task_messages", later);
      },
    ],
    [
      "a release before the delegated chat-done columns",
      async () => {
        await dropColumns("messages", delegated);
        await dropColumns("task_messages", delegated);
      },
    ],
    [
      "a feat/code database where only ai.messages got the delegated columns",
      async () => {
        await dropColumns("task_messages", delegated);
      },
    ],
    [
      "a database where ai.task_messages has some of them",
      async () => {
        await dropColumns("task_messages", delegated.slice(1));
      },
    ],
  ];

  for (const [name, rewind] of upgrades)
    test(`upgrade from ${name} leaves both tables with the same columns in the same order`, async () => {
      await rewind();
      await migrateCloudAi();
      await migrateCloudAi();
      expect(await columns("task_messages")).toEqual(await columns("messages"));
      // An older replica or a rolled-back image still unions both tables positionally.
      const [union] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM (SELECT * FROM ai.messages UNION ALL SELECT * FROM ai.task_messages) messages
        WHERE conversation_id = ${conversationId}::uuid`;
      expect(union!.count).toBe("2");
      for (const [loopId, text] of [
        [archivedTurnId, "Kept"],
        [liveTurnId, "Kept"],
      ] as const)
        for (const includeCompacted of [false, true]) {
          const messages = await aiConversations.listTurnMessages({ conversationId, loopId, includeCompacted });
          expect(messages.map((message) => message.message)).toEqual([{ role: "assistant", content: [{ type: "text", text }] }]);
        }
    });
});
