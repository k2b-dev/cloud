import { sql } from "@k2b/cloud";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { type AppEventDeliveryContext, type AppEventEnvelope, AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { appEventBroker, type ResourceEventBinding, registerResourceEventConsumer } from "@k2b/cloud/services/app-events";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { CODE_EVENT_CONSUMER } from "./event-subscriptions";
import { codeSettings } from "./settings";
import { findCode, insertCodeRun, listCodeRuns, readCode } from "./store";
import { requireCodeVersionApproval } from "./versions";

/** Commit the event receipt, pinned run and existing run outbox together before acknowledging the platform delivery. */
export async function admitCodeEvent(
  binding: ResourceEventBinding,
  envelope: AppEventEnvelope,
  context: AppEventDeliveryContext,
): Promise<void | { cancelled: true }> {
  context.signal.throwIfAborted();
  const backlog = await codeSettings.get("core.code.event_backlog");
  return sql.begin(async (db) => {
    await db`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await db`SELECT id FROM code.codes WHERE id=${binding.key} FOR UPDATE`;
    const code = await findCode(binding.key, db);
    const [subscription] = await db`SELECT id FROM events.app_subscriptions WHERE id=${context.subscriptionId}
      AND state='active' AND resource_binding=${JSON.stringify(binding)}::text::jsonb FOR SHARE`;
    const [account] = await db`SELECT id FROM auth.service_accounts WHERE id=${code?.serviceAccountId ?? null}::uuid
      AND kind='code' AND status='active' FOR SHARE`;
    const [currentMandate] = await db<{ workload_id: string }[]>`SELECT workload_id FROM auth.mandates
      WHERE id=${binding.mandateId}::uuid AND revision=${binding.mandateRevision} AND owner_app_id='runner'
        AND workload_type='code.version' AND state='active' AND confirmed_at IS NOT NULL
        AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND subject_kind='service_account'
        AND subject_service_account_id=${code?.serviceAccountId ?? null}::uuid FOR SHARE`;
    if (
      !subscription ||
      !account ||
      !code ||
      code.state !== "active" ||
      code.owner.kind !== "resource" ||
      !code.activeVersionId ||
      currentMandate?.workload_id !== code.activeVersionId ||
      code.owner.ref.type !== binding.place.type ||
      code.owner.ref.id !== binding.place.id ||
      envelope.place?.type !== binding.place.type ||
      envelope.place.id !== binding.place.id
    )
      return { cancelled: true as const };
    const requestKey = `event:${envelope.id}`;
    const [receipt] = await db`SELECT run_id FROM code.run_requests WHERE code_id=${code.id} AND request_key=${requestKey}`;
    if (receipt) return;
    const [delivery] = await db<{ seq: string; subject_key: string }[]>`SELECT seq,subject_key FROM events.app_deliveries
      WHERE subscription_id=${context.subscriptionId} AND event_id=${envelope.id}::uuid FOR SHARE`;
    if (!delivery) return { cancelled: true as const };
    const [version] = await db<{ manifest: unknown }[]>`SELECT manifest FROM code.versions WHERE id=${code.activeVersionId}::uuid`;
    const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
    const entry = manifest.entrypoints.find(
      (entry) => entry.kind === "event" && entry.event?.type === envelope.type && entry.event.version === envelope.version,
    );
    if (!entry?.event || entry.event.place.type !== binding.place.type || entry.event.place.id !== binding.place.id)
      return { cancelled: true as const };
    await requireCodeVersionApproval(code, code.activeVersionId, db);
    const [waiting] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM code.runs
      WHERE code_id=${code.id} AND trigger='event' AND state IN ('queued','running')`;
    if ((waiting?.count ?? 0) >= backlog) throw new Error("code_event_backlog_full");
    context.signal.throwIfAborted();
    const runId = await insertCodeRun(
      {
        codeId: code.id,
        versionId: code.activeVersionId,
        trigger: "event",
        entrypoint: entry.entrypoint,
        input: AppEventEnvelopeSchema.parse(envelope),
      },
      db,
    );
    await db`UPDATE code.runs SET event_subject_key=${`${envelope.type}@${envelope.version}:${delivery.subject_key}`},event_sequence=${delivery.seq}::bigint WHERE id=${runId}::uuid`;
    await db`INSERT INTO code.run_requests(code_id,request_key,run_id) VALUES(${code.id},${requestKey},${runId}::uuid)`;
    context.signal.throwIfAborted();
  });
}
export const startCodeEventConsumer = () => registerResourceEventConsumer(CODE_EVENT_CONSUMER, admitCodeEvent);

/** A compact, payload-free view beside the Code's runs. Only its exact subscription keys can be inspected. */
async function listCodeEventDeliveries(codeId: string) {
  return sql<
    {
      id: string;
      eventId: string;
      eventType: string;
      state: "pending" | "retrying" | "failed";
      code: string | null;
      attempts: number;
      createdAt: string;
    }[]
  >`
    SELECT delivery.id,delivery.event_id AS "eventId",event.type AS "eventType",delivery.state,CASE WHEN delivery.last_error='code_event_backlog_full' THEN delivery.last_error ELSE delivery.code END AS code,delivery.attempts,
      to_char(delivery.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM events.app_deliveries delivery JOIN events.app_subscriptions subscription ON subscription.id=delivery.subscription_id
    JOIN events.app_events event ON event.id=delivery.event_id
    WHERE subscription.resource_binding->>'consumer'=${CODE_EVENT_CONSUMER} AND subscription.resource_binding->>'key'=${codeId}
      AND delivery.state IN ('pending','retrying','failed') ORDER BY (delivery.state='failed') DESC,delivery.seq ASC LIMIT 20`;
}
/** Deliberate retry of delivery only; the permanent event receipt prevents repeating an admitted run. */
export async function replayCodeEventDelivery(codeId: string, deliveryId: string, context: CodeContext) {
  codePerson(context, true);
  const { permission } = await readCode(codeId, context);
  if (permission !== "editor") throw new CodeDataError("FORBIDDEN", "Only Code editors may retry delivery.");
  return sql
    .begin(async (db) => {
      await db`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      const code = await findCode(codeId, db);
      if (!code || code.state !== "active") throw new CodeDataError("CONFLICT", "Code must be active.");
      const [delivery] = await db`SELECT delivery.id FROM events.app_deliveries delivery
      JOIN events.app_subscriptions subscription ON subscription.id=delivery.subscription_id
      WHERE delivery.id=${deliveryId}::uuid AND delivery.state='failed' AND subscription.state='active'
        AND subscription.resource_binding->>'consumer'=${CODE_EVENT_CONSUMER} AND subscription.resource_binding->>'key'=${codeId}
      FOR UPDATE OF delivery`;
      if (!delivery) throw new CodeDataError("CONFLICT", "The failed delivery is no longer available for retry.");
      // The platform administration method owns retry counters, retention and audit. Run after releasing our row lock.
      return { id: String(delivery.id) };
    })
    .then(async (delivery) => {
      const result = await appEventBroker.redeliver(delivery.id, { userId: codePerson(context, true).id });
      if (!result) throw new CodeDataError("CONFLICT", "The delivery changed before retry.");
      return { deliveryId: delivery.id };
    });
}

export async function listCodeRunsWithEvents(input: Parameters<typeof listCodeRuns>[0], context: CodeContext) {
  const runs = await listCodeRuns(input, context);
  return { ...runs, eventDeliveries: await listCodeEventDeliveries(input.codeId) };
}
