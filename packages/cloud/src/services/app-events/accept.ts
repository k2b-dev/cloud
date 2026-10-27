import type { SQL } from "bun";
import { z } from "zod";
import { type AppEventEnvelope, AppEventEnvelopeSchema } from "../../contracts/app-events";
import type { StoredDeclaration } from "./declarations";

export function createEventAcceptance(db: SQL, reconcile: () => Promise<void>, checkGap: () => Promise<void>) {
  const markSeen = async (sequence: number) => {
    await db`
      UPDATE events.app_broker_status SET last_sequence = GREATEST(last_sequence, ${sequence}), updated_at = now()
      WHERE id = true AND last_sequence < ${sequence}
    `;
  };
  const accept = async (input: AppEventEnvelope, sequence: number, attempt = 3) => {
    const envelope = AppEventEnvelopeSchema.parse(input);
    await reconcile();
    await checkGap();
    const [declaration] = await db<StoredDeclaration[]>`
      SELECT * FROM events.app_declarations
      WHERE app_id = ${envelope.source} AND type = ${envelope.type} AND version = ${envelope.version}
    `;
    let code: string | null = null;
    if (!declaration) {
      if (attempt < 3) throw new Error("Event declaration registration is not ready");
      code = "event_not_declared";
    } else if (
      envelope.subject.type !== `${declaration.app_id}.${declaration.subject}` ||
      (declaration.place ? envelope.place?.type !== `${declaration.app_id}.${declaration.place}` : envelope.place !== undefined)
    ) {
      code = "reference_mismatch";
    } else if (!z.fromJSONSchema(declaration.data_schema).safeParse(envelope.data).success) {
      code = "schema_mismatch";
    }
    const subjectKey = `${envelope.subject.type}:${envelope.subject.id}`;
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
      await tx`
        UPDATE events.app_broker_status SET last_sequence = GREATEST(last_sequence, ${sequence}), updated_at = now()
        WHERE id = true AND last_sequence < ${sequence}
      `;
    });
  };
  return { accept, markSeen };
}
