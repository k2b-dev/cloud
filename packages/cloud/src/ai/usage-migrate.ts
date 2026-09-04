import { sql } from "bun";

/** Keep accounting on the turn, independently of retry/edit message truncation. */
export const migrateAiTurnUsage = async (): Promise<void> => {
  await sql.begin(async (tx) => {
    // Install the backfill and capture together: no message may slip between them.
    await tx`LOCK TABLE ai.messages, ai.turns IN SHARE ROW EXCLUSIVE MODE`;
    const [existing] = await tx<{ present: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'turns' AND column_name = 'usage') AS present
    `;
    await tx`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS usage JSONB,
      ADD COLUMN IF NOT EXISTS provider_model TEXT, ADD COLUMN IF NOT EXISTS loop_aggregate JSONB`;

    await tx`
      CREATE OR REPLACE FUNCTION ai.add_token_usage(a jsonb, b jsonb) RETURNS jsonb
      LANGUAGE sql IMMUTABLE AS $$
        SELECT jsonb_object_agg(key, value) FROM (
          SELECT key, sum(value::double precision) AS value
          FROM (
            SELECT * FROM jsonb_each_text(CASE WHEN jsonb_typeof(a) = 'string' THEN (a #>> '{}')::jsonb ELSE a END)
            UNION ALL
            SELECT * FROM jsonb_each_text(CASE WHEN jsonb_typeof(b) = 'string' THEN (b #>> '{}')::jsonb ELSE b END)
          ) entries
          WHERE key IN ('input', 'output', 'total', 'creditsUsed') GROUP BY key
        ) sums
      $$
    `.simple();
    if (!existing?.present) {
      await tx`
        WITH facts AS (
          SELECT turn.id,
            (SELECT jsonb_object_agg(key, value) FROM (
              SELECT entry.key, sum(entry.value::double precision) AS value
              FROM ai.messages message,
                LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(message.usage) = 'string'
                  THEN (message.usage #>> '{}')::jsonb ELSE message.usage END) entry
              WHERE message.conversation_id = turn.conversation_id AND message.loop_id = turn.id::text
                AND message.kind = 'message' AND message.role = 'assistant'
                AND entry.key IN ('input', 'output', 'total', 'creditsUsed') GROUP BY entry.key
            ) sums) AS usage,
            (SELECT message.provider_model FROM ai.messages message
              WHERE message.conversation_id = turn.conversation_id AND message.loop_id = turn.id::text
                AND message.kind = 'message' AND message.role = 'assistant'
              ORDER BY message.created_at DESC, message.seq DESC LIMIT 1) AS provider_model,
            (SELECT CASE WHEN jsonb_typeof(message.loop_aggregate) = 'string'
                THEN (message.loop_aggregate #>> '{}')::jsonb ELSE message.loop_aggregate END
              FROM ai.messages message
              WHERE message.conversation_id = turn.conversation_id AND message.loop_id = turn.id::text
                AND message.kind = 'message' AND message.role = 'assistant' AND message.loop_aggregate IS NOT NULL
              ORDER BY message.created_at DESC, message.seq DESC LIMIT 1) AS loop_aggregate
          FROM ai.turns turn
        )
        UPDATE ai.turns turn SET usage = COALESCE(facts.usage, facts.loop_aggregate->'usage'),
          provider_model = facts.provider_model, loop_aggregate = facts.loop_aggregate
        FROM facts WHERE turn.id = facts.id
      `;
    }
    await tx`
      CREATE OR REPLACE FUNCTION ai.capture_turn_usage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'message' AND NEW.role = 'assistant' AND NEW.loop_id IS NOT NULL THEN
          IF TG_OP = 'INSERT' THEN
            UPDATE ai.turns SET usage = ai.add_token_usage(usage, NEW.usage),
              provider_model = COALESCE(NEW.provider_model, provider_model),
              loop_aggregate = COALESCE(NEW.loop_aggregate, loop_aggregate)
            WHERE conversation_id = NEW.conversation_id AND id::text = NEW.loop_id;
          ELSE
            UPDATE ai.turns SET loop_aggregate = CASE WHEN jsonb_typeof(NEW.loop_aggregate) = 'string'
              THEN (NEW.loop_aggregate #>> '{}')::jsonb ELSE NEW.loop_aggregate END
            WHERE conversation_id = NEW.conversation_id AND id::text = NEW.loop_id;
          END IF;
        END IF;
        RETURN NEW;
      END $$
    `.simple();
    await tx`DROP TRIGGER IF EXISTS ai_capture_turn_usage ON ai.messages`;
    await tx`CREATE TRIGGER ai_capture_turn_usage AFTER INSERT OR UPDATE OF loop_aggregate ON ai.messages
      FOR EACH ROW EXECUTE FUNCTION ai.capture_turn_usage()`;
  });
};
