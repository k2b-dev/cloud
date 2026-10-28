import type { SQL } from "bun";
import { z } from "zod";
import { assertAppEventSize } from "../../_internal/app-event-schemas";
import { AppEventEnvelopeSchema } from "../../contracts/app-events";
import { logger } from "../logging";
import type { StoredDeclaration } from "./declarations";

const log = logger("app-events:accept");
// Additive envelope metadata from a newer publisher is compatible with older Core.
const Envelope = AppEventEnvelopeSchema.strip().extend({ version: z.number().int().min(1).max(2_147_483_647) });
const Metadata = z.object({
  id: z.uuid(),
  type: Envelope.shape.type.catch("unknown"),
  source: Envelope.shape.source.catch("unknown"),
  version: Envelope.shape.version.catch(1),
});

export function createEventAcceptance(db: SQL, reconcile: () => Promise<void>) {
  const markSeen = async (sequence: number, tx: SQL = db) => {
    // Keep holes until replay or the periodic DLQ/retention check accounts for them.
    // Advancing the high watermark alone would hide eviction before the next tick.
    await tx`
      UPDATE events.app_broker_status SET
        unseen_sequences = (unseen_sequences + CASE WHEN last_sequence + 1 < ${sequence} THEN
          int8multirange(int8range(last_sequence + 1, ${sequence}::bigint, '[)')) ELSE '{}'::int8multirange END)
          - int8multirange(int8range(${sequence}::bigint, ${sequence + 1}::bigint, '[)')),
        last_sequence = GREATEST(last_sequence, ${sequence}), updated_at = now()
      WHERE id = true AND (last_sequence < ${sequence} OR unseen_sequences @> ${sequence}::bigint)
    `;
  };
  const reject = async (input: unknown, sequence: number, code: string) => {
    const metadata = Metadata.safeParse(input);
    if (!metadata.success) {
      log.warn("Discarding invalid app event without a usable ID", { sequence, code });
      await markSeen(sequence);
      return;
    }
    const { id, type, source, version } = metadata.data;
    await db.begin(async (tx) => {
      // Invalid or oversized input is represented by metadata only, never a second failing payload insert.
      await tx`
        INSERT INTO events.app_events(id, type, version, source, subject_key, envelope, state, code)
        VALUES (${id}::uuid, ${type}, ${version}, ${source}, ${`unknown:${id}`}, '{}'::jsonb, 'rejected', ${code})
        ON CONFLICT(id) DO NOTHING
      `;
      await markSeen(sequence, tx);
    });
  };
  const accept = async (input: unknown, sequence: number, attempt = 3) => {
    const parsed = Envelope.safeParse(input);
    if (!parsed.success) return reject(input, sequence, "invalid_envelope");
    const envelope = parsed.data;
    try {
      assertAppEventSize(envelope);
    } catch {
      return reject(envelope, sequence, "event_too_large");
    }
    // Persisted declarations remain authoritative while discovery is unavailable.
    try {
      await reconcile();
    } catch {
      log.warn("Declaration refresh failed; accepting against persisted declarations", { sequence });
    }
    const [declaration] = await db<StoredDeclaration[]>`
      SELECT * FROM events.app_declarations
      WHERE app_id = ${envelope.source} AND type = ${envelope.type} AND version = ${envelope.version}
    `;
    let code: string | null = null;
    if (!declaration) {
      if (attempt < 3) throw new Error("Event declaration registration is not ready");
      code = "event_not_declared";
    } else if (declaration.retired_at) {
      code = "event_not_declared";
    } else if (
      envelope.subject.type !== `${declaration.app_id}.${declaration.subject}` ||
      (declaration.place ? envelope.place?.type !== `${declaration.app_id}.${declaration.place}` : envelope.place !== undefined)
    ) {
      code = "reference_mismatch";
    } else {
      try {
        if (!z.fromJSONSchema(declaration.data_schema).safeParse(envelope.data).success) code = "schema_mismatch";
      } catch {
        code = "invalid_declaration_schema";
      }
    }
    const subjectKey = `${envelope.subject.type}:${envelope.subject.id}`;
    try {
      await db.begin(async (tx) => {
        const inserted = await tx`
          INSERT INTO events.app_events(id, type, version, source, subject_key, envelope, state, code)
          VALUES (${envelope.id}::uuid, ${envelope.type}, ${envelope.version}, ${envelope.source}, ${subjectKey},
            ${JSON.stringify(envelope)}::text::jsonb, ${code ? "rejected" : "accepted"}, ${code})
          ON CONFLICT(id) DO NOTHING RETURNING id
        `;
        if (inserted.length && !code) {
          await tx`
            INSERT INTO events.app_deliveries(id, subscription_id, event_id, subject_key)
            SELECT gen_random_uuid(), id, ${envelope.id}::uuid, ${subjectKey} FROM events.app_subscriptions
            WHERE event_type = ${envelope.type} AND version = ${envelope.version} AND state = 'active'
            ON CONFLICT(subscription_id, event_id) DO NOTHING
          `;
        }
        await markSeen(sequence, tx);
      });
    } catch (error) {
      // PostgreSQL data exceptions and CHECK failures are deterministic; infrastructure failures retry.
      const sqlState = error instanceof Error && "errno" in error ? error.errno : undefined;
      if (typeof sqlState === "string" && (sqlState.startsWith("22") || sqlState === "23514")) {
        await reject(envelope, sequence, sqlState === "23514" ? "event_too_large" : "invalid_envelope");
        return;
      }
      throw error;
    }
  };
  return { accept, markSeen };
}
