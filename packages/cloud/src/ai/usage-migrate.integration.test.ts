import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrateAiTurnUsage } from "./usage-migrate";

// This legacy-schema fixture owns its tables. Never run it on the normal usage
// test database, a developer database, or an existing AI schema.
const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/unconfigured");
const isolated =
  ["127.0.0.1", "localhost"].includes(databaseUrl.hostname) &&
  /^\/cloud_ai_usage_verify_upgrade(?:_[a-z0-9_]+)?$/.test(databaseUrl.pathname);
const suite = isolated ? describe : describe.skip;

type AccountingRow = {
  id: string;
  usage: { input?: number; output?: number; total?: number; creditsUsed?: number } | null;
  provider_model: string | null;
  loop_aggregate: { timing?: { generationMs: number } } | null;
};

suite("AI usage legacy upgrade", () => {
  test("backfills existing responses once and retains facts after retry deletes messages", async () => {
    const [existing] = await sql<{ turns: string | null; messages: string | null }[]>`
      SELECT to_regclass('ai.turns')::text AS turns, to_regclass('ai.messages')::text AS messages
    `;
    if (existing?.turns || existing?.messages) throw new Error("Upgrade fixture requires a database without AI tables.");
    await sql`CREATE SCHEMA IF NOT EXISTS ai`;
    await sql`CREATE TABLE ai.turns (id UUID PRIMARY KEY, conversation_id UUID NOT NULL)`;
    await sql`CREATE TABLE ai.messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL,
      loop_id TEXT, seq INTEGER, kind TEXT, role TEXT, provider_model TEXT,
      usage JSONB, loop_aggregate JSONB, created_at TIMESTAMPTZ DEFAULT now()
    )`;
    try {
      const conversationId = crypto.randomUUID();
      const otherConversationId = crypto.randomUUID();
      const turns = {
        responses: crypto.randomUUID(),
        missing: crypto.randomUUID(),
        zero: crypto.randomUUID(),
        aggregateOnly: crypto.randomUUID(),
        empty: crypto.randomUUID(),
      };
      for (const id of Object.values(turns)) await sql`INSERT INTO ai.turns VALUES (${id}::uuid, ${conversationId}::uuid)`;
      await sql`
        INSERT INTO ai.messages (conversation_id, loop_id, seq, kind, role, provider_model, usage, loop_aggregate)
        VALUES
          (${conversationId}::uuid, ${turns.responses}, 1, 'message', 'assistant', 'provider/one', '{"input":80,"output":20,"total":100,"creditsUsed":0.1}', NULL),
          (${conversationId}::uuid, ${turns.responses}, 2, 'message', 'assistant', 'provider/two', to_jsonb('{"input":160,"output":40,"total":200,"creditsUsed":0.2}'::text), to_jsonb('{"timing":{"generationMs":1200}}'::text)),
          (${otherConversationId}::uuid, ${turns.responses}, 3, 'message', 'assistant', 'provider/copy', '{"total":9000,"creditsUsed":99}', NULL),
          (${conversationId}::uuid, ${turns.responses}, 4, 'summary', 'assistant', 'provider/summary', '{"total":500}', NULL),
          (${conversationId}::uuid, ${turns.missing}, 5, 'message', 'assistant', 'provider/unknown', NULL, NULL),
          (${conversationId}::uuid, ${turns.zero}, 6, 'message', 'assistant', 'provider/zero', '{"input":0,"output":0,"total":0,"creditsUsed":0}', NULL),
          (${conversationId}::uuid, ${turns.aggregateOnly}, 7, 'message', 'assistant', 'provider/legacy', NULL, '{"usage":{"input":8,"output":2,"total":10,"creditsUsed":0.01},"timing":{"generationMs":50}}')
      `;
      await migrateAiTurnUsage();
      const rows = await sql<AccountingRow[]>`SELECT * FROM ai.turns`;
      const response = rows.find((row) => row.id === turns.responses);
      expect(response?.usage).toMatchObject({ input: 240, output: 60, total: 300 });
      expect(response?.usage?.creditsUsed).toBeCloseTo(0.3);
      expect(response?.provider_model).toBe("provider/two");
      expect(response?.loop_aggregate).toEqual({ timing: { generationMs: 1200 } });
      expect(rows.find((row) => row.id === turns.missing)?.usage).toBeNull();
      expect(rows.find((row) => row.id === turns.empty)).toMatchObject({ usage: null, provider_model: null, loop_aggregate: null });
      expect(rows.find((row) => row.id === turns.zero)?.usage).toEqual({ input: 0, output: 0, total: 0, creditsUsed: 0 });
      expect(rows.find((row) => row.id === turns.aggregateOnly)?.usage).toEqual({ input: 8, output: 2, total: 10, creditsUsed: 0.01 });

      // A retry removes old messages. Restarting the application must not erase
      // their accounting or add the remaining messages a second time.
      await sql`DELETE FROM ai.messages WHERE loop_id = ${turns.responses}`;
      await migrateAiTurnUsage();
      const after = await sql<AccountingRow[]>`SELECT * FROM ai.turns ORDER BY id`;
      expect(after).toEqual([...rows].sort((a, b) => a.id.localeCompare(b.id)));

      await sql`
        INSERT INTO ai.messages (conversation_id, loop_id, seq, kind, role, usage)
        VALUES (${conversationId}::uuid, ${turns.responses}, 8, 'message', 'assistant', '{"input":4,"output":1,"total":5,"creditsUsed":0.05}')
      `;
      const [appended] = await sql<AccountingRow[]>`SELECT * FROM ai.turns WHERE id = ${turns.responses}::uuid`;
      expect(appended?.usage).toMatchObject({ input: 244, output: 61, total: 305 });
      expect(appended?.usage?.creditsUsed).toBeCloseTo(0.35);
    } finally {
      // Both tables were created by this fixture after the absence check.
      await sql`DROP TABLE ai.messages`;
      await sql`DROP TABLE ai.turns`;
    }
  });
});
