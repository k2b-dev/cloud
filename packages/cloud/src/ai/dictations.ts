import { sql } from "bun";
import { z } from "zod";
import { inspectAiAudio } from "./audio-format";
import { createUniqueAiFileInTransaction } from "./files-store";
import { AiSaveConversationDraftInputSchema } from "./http";
import { withAiShortIdForDb } from "./short-id";
import { saveAiDraftInTransaction } from "./store";
import type { AiResolvedAudioModel } from "./transcription";

export const AiDictationStartSchema = z.object({
  operationId: z.uuid(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
});
export const AiDictationListSchema = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });
export type AiDictationStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
export type AiDictationDisposition = "pending" | "applied" | "discarded";
export type AiDictation = {
  id: string;
  sourcePath: string;
  operationId: string;
  status: AiDictationStatus;
  disposition: AiDictationDisposition;
  errorCode: string | null;
  createdAt: string;
};
type DictationRow = {
  id: string;
  short_id: string;
  operation_id: string;
  source_path: string;
  status: AiDictationStatus;
  disposition: AiDictationDisposition;
  error_code: string | null;
  created_at: Date;
  result: string | null;
  request_hash: string;
};
const publicDictation = (row: DictationRow): AiDictation => ({
  id: row.short_id,
  sourcePath: row.source_path,
  operationId: row.operation_id,
  status: row.status,
  disposition: row.disposition,
  errorCode: row.error_code,
  createdAt: row.created_at.toISOString(),
});
export class AiDictationConflict extends Error {}

const lockConversation = async (tx: typeof sql, conversationId: string, userId: string) => {
  const [row] =
    await tx`SELECT id FROM ai.conversations WHERE id = ${conversationId} AND created_by_user_id = ${userId} AND archived_at IS NULL FOR UPDATE`;
  if (!row) throw new Error("Conversation is unavailable.");
};

export const aiDictations = {
  async start(input: {
    conversationId: string;
    userId: string;
    operationId: string;
    bytes: Uint8Array;
    language?: string;
    resolveModel: () => Promise<AiResolvedAudioModel>;
  }): Promise<AiDictation> {
    AiDictationStartSchema.parse(input);
    const format = inspectAiAudio(input.bytes);
    const hash = new Bun.CryptoHasher("sha256")
      .update(input.bytes)
      .update(JSON.stringify({ language: input.language ?? null }))
      .digest("hex");
    return sql.begin(async (tx) => {
      await lockConversation(tx, input.conversationId, input.userId);
      const [canceled] = await tx`SELECT operation_id FROM ai.dictation_cancellations
        WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND operation_id = ${input.operationId}`;
      if (canceled) throw new AiDictationConflict("This recording operation was discarded.");
      const [previous] = await tx<
        DictationRow[]
      >`SELECT * FROM ai.dictations WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND operation_id = ${input.operationId}`;
      if (previous) {
        if (previous.request_hash !== hash)
          throw new AiDictationConflict("This recording operation already has different audio or options.");
        return publicDictation(previous);
      }
      const [pending] =
        await tx`SELECT id FROM ai.dictations WHERE conversation_id = ${input.conversationId} AND disposition = 'pending' LIMIT 1`;
      if (pending) throw new AiDictationConflict("Finish or discard the pending dictation before starting another.");
      const model = await input.resolveModel();
      const row = await withAiShortIdForDb(tx, "ai_dictations_short_id_key", async (db, shortId) => {
        const [created] = await db<DictationRow[]>`
          INSERT INTO ai.dictations (short_id, conversation_id, user_id, operation_id, request_hash, source_path, source_bytes, media_type, model_profile_id, language)
          VALUES (${shortId}, ${input.conversationId}, ${input.userId}, ${input.operationId}, ${hash}, ${`/dictation-${shortId}.${format.extension}`}, ${input.bytes}, ${format.mediaType}, ${model.profile.id}, ${input.language ?? null}) RETURNING *
        `;
        return created!;
      });
      // The inserted snapshot is already counted by the normal file-write quota.
      const file = await createUniqueAiFileInTransaction(tx, {
        conversationId: input.conversationId,
        path: row.source_path,
        bytes: input.bytes,
        mediaType: format.mediaType,
        origin: "user",
      });
      await tx`UPDATE ai.dictations SET source_path = ${file.path} WHERE id = ${row.id}`;
      return publicDictation({ ...row, source_path: file.path });
    });
  },
  async list(input: { conversationId: string; userId: string; after?: string; limit?: number }) {
    const limit = Math.min(50, Math.max(1, input.limit ?? 20));
    // Cursor is opaque to the UI but validated as a UUID at the API boundary.
    const rows = await sql<DictationRow[]>`
      SELECT d.id, d.short_id, d.operation_id, d.source_path, d.status, d.disposition, d.error_code, d.created_at
      FROM ai.dictations d JOIN ai.conversations c ON c.id = d.conversation_id
      WHERE d.conversation_id = ${input.conversationId} AND c.created_by_user_id = ${input.userId} AND c.archived_at IS NULL
        AND d.disposition = 'pending' AND (${input.after ?? null}::uuid IS NULL OR d.id > ${input.after ?? null}::uuid)
      ORDER BY d.id LIMIT ${limit + 1}
    `;
    return { items: rows.slice(0, limit).map(publicDictation), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  },
  async get(input: { conversationId: string; userId: string; id: string }) {
    const [row] = await sql<DictationRow[]>`
      SELECT d.* FROM ai.dictations d JOIN ai.conversations c ON c.id = d.conversation_id
      WHERE d.conversation_id = ${input.conversationId} AND c.created_by_user_id = ${input.userId} AND c.archived_at IS NULL AND d.short_id = ${input.id}
    `;
    return row ? { ...publicDictation(row), text: row.result } : null;
  },
  async discard(input: { conversationId: string; userId: string; id: string }) {
    return sql.begin(async (tx) => {
      await lockConversation(tx, input.conversationId, input.userId);
      await tx`UPDATE ai.dictations SET disposition = 'discarded', status = CASE WHEN status IN ('queued', 'running') THEN 'canceled' ELSE status END,
        source_bytes = NULL, lease_token = NULL, lease_until = NULL, updated_at = now()
        WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND short_id = ${input.id} AND disposition = 'pending'`;
    });
  },
  async discardOperation(input: { conversationId: string; userId: string; operationId: string }) {
    z.uuid().parse(input.operationId);
    return sql.begin(async (tx) => {
      // Same lock as start/apply: the marker also fences a start that has not arrived yet.
      await lockConversation(tx, input.conversationId, input.userId);
      const [row] = await tx<DictationRow[]>`SELECT * FROM ai.dictations
        WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND operation_id = ${input.operationId}`;
      if (row?.disposition === "applied") return { disposition: "applied" as const };
      await tx`INSERT INTO ai.dictation_cancellations (conversation_id, user_id, operation_id)
        VALUES (${input.conversationId}, ${input.userId}, ${input.operationId}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE ai.dictations SET disposition = 'discarded', status = 'canceled',
        source_bytes = NULL, lease_token = NULL, lease_until = NULL, updated_at = now()
        WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND operation_id = ${input.operationId}
          AND disposition = 'pending'`;
      return { disposition: "discarded" as const };
    });
  },
  async retry(input: { conversationId: string; userId: string; id: string }) {
    return sql.begin(async (tx) => {
      await lockConversation(tx, input.conversationId, input.userId);
      await tx`UPDATE ai.dictations SET status = 'queued', attempts = 0, error_code = NULL, next_attempt_at = now(), updated_at = now()
        WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND short_id = ${input.id}
          AND status = 'failed' AND disposition = 'pending' AND source_bytes IS NOT NULL`;
    });
  },
  async apply(input: { conversationId: string; userId: string; id: string } & z.infer<typeof AiSaveConversationDraftInputSchema>) {
    AiSaveConversationDraftInputSchema.parse(input);
    return sql.begin(async (tx) => {
      await lockConversation(tx, input.conversationId, input.userId);
      const [row] = await tx<
        DictationRow[]
      >`SELECT * FROM ai.dictations WHERE conversation_id = ${input.conversationId} AND user_id = ${input.userId} AND short_id = ${input.id} FOR UPDATE`;
      if (!row) throw new Error("Dictation is unavailable.");
      if (row.disposition !== "pending") return { disposition: row.disposition, draft: null };
      if (row.status !== "succeeded" || row.result === null) throw new AiDictationConflict("Dictation is not ready.");
      const text = [...input.content.filter((part) => part.type === "text").map((part) => part.text), row.result]
        .filter(Boolean)
        .join("\n\n");
      const content = [...(text ? [{ type: "text" as const, text }] : []), ...input.content.filter((part) => part.type !== "text")];
      AiSaveConversationDraftInputSchema.parse({ expectedRevision: input.expectedRevision, content });
      const saved = await saveAiDraftInTransaction(tx, {
        conversationId: input.conversationId,
        ownerUserId: input.userId,
        expectedRevision: input.expectedRevision,
        content,
      });
      if (!saved.ok) throw new AiDictationConflict("The conversation draft changed. Review the saved draft before inserting.");
      await tx`UPDATE ai.dictations SET disposition = 'applied', updated_at = now() WHERE id = ${row.id}`;
      return { disposition: "applied" as const, draft: saved.draft };
    });
  },
};
