import { sql } from "bun";
import { z } from "zod";
import { toPgTextArray } from "../services/postgres";
import type { AiMap, AiMapCommand } from "./map-contracts";
import { AiMapSchema, aiMapToolResult } from "./map-contracts";
import type { AiStoredMessage } from "./types";

export class AiMapConflict extends Error {
  constructor() {
    super("MAP_REVISION_CONFLICT");
  }
}
export type AiMapStored = { map: AiMap; retry?: AiMapCommand };
export const migrateAiMaps = async () => {
  await sql`CREATE TABLE IF NOT EXISTS ai.maps (
    id UUID PRIMARY KEY, conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, snapshot JSONB NOT NULL, retry JSONB,
    CONSTRAINT ai_map_revision CHECK (revision > 0)
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_maps_conversation ON ai.maps(conversation_id)`.simple();
};
const decode = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const referenceId = z.object({ map: z.object({ id: z.uuid() }) });
export const aiMaps = {
  /** A model turn stops paid map work after an overrun, including a request for a new map. */
  async hasCostOverrunInTurn(conversationId: string, turnId: string): Promise<boolean> {
    const [row] = await sql<{ found: boolean }[]>`SELECT EXISTS(SELECT 1 FROM ai.maps
      WHERE conversation_id=${conversationId}::uuid AND (snapshot->'issue'->>'code'='GEO_COST_OVERRUN' OR snapshot->'issue'->>'requiresCostConfirmation'='true')
      AND snapshot->'issue'->>'turnId'=${turnId}) AS found`;
    return row?.found === true;
  },
  async read(conversationId: string, id: string): Promise<AiMapStored | null> {
    const [row] = await sql<
      { snapshot: unknown; retry: AiMapCommand | null; anchor_seq: number | null }[]
    >`SELECT snapshot, retry,(SELECT MIN(seq) FROM ai.messages WHERE conversation_id=ai.maps.conversation_id AND ((role='tool_result' AND message->>'name'='map' AND message->'result'->>'anchor'='true' AND message->'result'->'map'->>'id'=ai.maps.id::text) OR (role='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(message->'content') block WHERE block->>'type'='tool_call' AND block->>'id'=ai.maps.snapshot->>'originCallId')))) AS anchor_seq FROM ai.maps WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
    return row
      ? {
          map: { ...AiMapSchema.parse(decode(row.snapshot)), viewedAt: new Date().toISOString(), anchorSeq: row.anchor_seq ?? undefined },
          retry: row.retry ?? undefined,
        }
      : null;
  },
  async mutate(
    conversationId: string,
    ownerUserId: string,
    revision: number,
    id: string,
    operation: (before: AiMapStored) => Promise<AiMapStored>,
  ): Promise<AiMapStored> {
    return sql.begin(async (tx) => {
      const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${id},0)) AS locked`;
      if (!lock?.locked) throw new AiMapConflict();
      const [row] = await tx<
        { snapshot: unknown; retry: AiMapCommand | null }[]
      >`SELECT snapshot,retry FROM ai.maps WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid AND revision=${revision} FOR UPDATE`;
      if (!row) throw new AiMapConflict();
      const [owner] =
        await tx`SELECT id FROM ai.conversations WHERE id=${conversationId}::uuid AND created_by_user_id=${ownerUserId}::uuid AND archived_at IS NULL FOR SHARE`;
      if (!owner) throw new Error("MAP_FORBIDDEN");
      const before = { map: AiMapSchema.parse(decode(row.snapshot)), retry: row.retry ?? undefined };
      if (before.map.pendingTurnId) {
        const [active] =
          await tx`SELECT id FROM ai.turns WHERE id=${before.map.pendingTurnId}::uuid AND conversation_id=${conversationId}::uuid AND status IN ('queued','running','waiting_for_action')`;
        if (active) throw new AiMapConflict();
      }
      const next = await operation(before);
      await tx`UPDATE ai.maps SET revision=${next.map.revision},snapshot=${JSON.stringify(AiMapSchema.parse(next.map))}::text::jsonb,retry=${next.retry ? JSON.stringify(next.retry) : null}::text::jsonb WHERE id=${id}::uuid AND conversation_id=${conversationId}::uuid`;
      return next;
    });
  },
  async save(conversationId: string, ownerUserId: string, value: AiMapStored, expected?: number) {
    return sql.begin(async (tx) => {
      const [owner] =
        await tx`SELECT id FROM ai.conversations WHERE id=${conversationId}::uuid AND created_by_user_id=${ownerUserId}::uuid AND archived_at IS NULL FOR SHARE`;
      if (!owner) throw new Error("MAP_FORBIDDEN");
      const snapshot = JSON.stringify(AiMapSchema.parse(value.map));
      const rows =
        expected === undefined
          ? await tx`INSERT INTO ai.maps(id,conversation_id,revision,snapshot,retry) VALUES(${value.map.id}::uuid,${conversationId}::uuid,${value.map.revision},${snapshot}::text::jsonb,${value.retry ? JSON.stringify(value.retry) : null}::text::jsonb) ON CONFLICT DO NOTHING RETURNING id`
          : await tx`UPDATE ai.maps SET revision=${value.map.revision},snapshot=${snapshot}::text::jsonb,retry=${value.retry ? JSON.stringify(value.retry) : null}::text::jsonb WHERE id=${value.map.id}::uuid AND conversation_id=${conversationId}::uuid AND revision=${expected} RETURNING id`;
      if (!rows.length) throw new AiMapConflict();
    });
  },
};

/** Human and model history resolve map references from the same current snapshot, without rewriting conversation text. */
export async function projectAiMaps(messages: AiStoredMessage[], compact = false): Promise<AiStoredMessage[]> {
  const mapIds: string[] = [],
    callIds: string[] = [];
  for (const entry of messages) {
    const message = entry.message;
    if (message.role === "assistant")
      callIds.push(...message.content.flatMap((b) => (b.type === "tool_call" && b.name === "map" ? [b.id] : [])));
    if (message.role !== "tool_result" || message.name !== "map") continue;
    callIds.push(message.callId);
    const result = message.result;
    const reference = referenceId.safeParse(result);
    if (reference.success) mapIds.push(reference.data.map.id);
  }
  if (!callIds.length && !mapIds.length) return messages;
  const conversations = [...new Set(messages.map((m) => m.conversationId))];
  const rows = await sql<{ conversation_id: string; snapshot: unknown; anchor_seq: number | null }[]>`SELECT conversation_id,snapshot,
    (SELECT MIN(seq) FROM ai.messages WHERE conversation_id=ai.maps.conversation_id AND
      ((role='tool_result' AND message->>'name'='map' AND message->'result'->>'anchor'='true' AND message->'result'->'map'->>'id'=ai.maps.id::text)
       OR (role='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(message->'content') block WHERE block->>'type'='tool_call' AND block->>'id'=ai.maps.snapshot->>'originCallId')))) AS anchor_seq
    FROM ai.maps WHERE conversation_id=ANY(${toPgTextArray(conversations)}::uuid[]) AND (id=ANY(${toPgTextArray(mapIds)}::uuid[]) OR snapshot->>'originCallId'=ANY(${toPgTextArray(callIds)}::text[]))`;
  const viewedAt = new Date().toISOString();
  const maps = rows.map((row) => ({
    conversationId: row.conversation_id,
    map: { ...AiMapSchema.parse(decode(row.snapshot)), viewedAt, anchorSeq: row.anchor_seq ?? undefined },
  }));
  const output = (map: AiMap, anchor: boolean) => (compact ? aiMapToolResult(map, anchor) : { map, anchor });
  return messages.map((entry) => {
    const own = maps.filter((row) => row.conversationId === entry.conversationId);
    const message = entry.message;
    if (message.role === "assistant") {
      const partial = Object.fromEntries(
        message.content.flatMap((block) => {
          if (block.type !== "tool_call" || block.name !== "map") return [];
          const current = own.find((row) => row.map.originCallId === block.id);
          return current ? [[block.id, output(current.map, true)]] : [];
        }),
      );
      return Object.keys(partial).length
        ? { ...entry, meta: { ...entry.meta, toolInterimResults: { ...entry.meta?.toolInterimResults, ...partial } } }
        : entry;
    }
    if (message.role !== "tool_result" || message.name !== "map") return entry;
    const result = message.result;
    const reference = referenceId.safeParse(result);
    const current = own.find((row) => (reference.success ? row.map.id === reference.data.map.id : row.map.originCallId === message.callId));
    if (!current) return reference.success ? { ...entry, message: { ...message, result: { error: "MAP_UNAVAILABLE" } } } : entry;
    const anchor =
      result && typeof result === "object" && "anchor" in result ? result.anchor === true : current.map.originCallId === message.callId;
    return { ...entry, message: { ...message, ...(compact ? { historicalResult: undefined } : {}), result: output(current.map, anchor) } };
  });
}
