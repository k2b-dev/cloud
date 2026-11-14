import { sql } from "@k2b/cloud";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { type AppEventDeliveryContext, type AppEventEnvelope, AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { audit } from "@k2b/cloud/services";
import { type ResourceEventBinding, registerResourceEventConsumer, replayResourceEventDelivery } from "@k2b/cloud/services/app-events";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { codeEventEntry, codeEventPrincipal } from "./event-access";
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
    if (!code) return { cancelled: true as const };
    const principal = codeEventPrincipal(code);
    const [account] =
      principal.type === "user"
        ? await db`SELECT id FROM auth.users WHERE id=${principal.userId}::uuid FOR SHARE`
        : await db`SELECT id FROM auth.service_accounts WHERE id=${principal.serviceAccountId}::uuid AND kind='code' AND status='active' FOR SHARE`;
    const [currentMandate] = await db<{ workload_id: string }[]>`SELECT workload_id FROM auth.mandates
      WHERE id=${binding.mandateId}::uuid AND revision=${binding.mandateRevision} AND owner_app_id='runner'
        AND workload_type='code.version' AND state='active' AND confirmed_at IS NOT NULL
        AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND subject_kind=${principal.type}
        AND COALESCE(subject_user_id,subject_service_account_id)=${principal.type === "user" ? principal.userId : principal.serviceAccountId}::uuid FOR SHARE`;
    if (
      !subscription ||
      !account ||
      code.state !== "active" ||
      !code.activeVersionId ||
      currentMandate?.workload_id !== code.activeVersionId ||
      envelope.place?.type !== binding.place.type ||
      envelope.place.id !== binding.place.id
    )
      return { cancelled: true as const };
    const requestKey = `event:${envelope.id}`;
    const [receipt] = await db`SELECT run_id FROM code.run_requests WHERE code_id=${code.id} AND request_key=${requestKey}`;
    let recoverRun: string | undefined;
    if (receipt) {
      const [run] = await db<{ id: string; recoverable: boolean }[]>`SELECT id,
        (trigger='event' AND generation=0 AND started_at IS NULL AND NOT effect_started
          AND state='failed' AND outcome='code_not_active'
          AND EXISTS(SELECT FROM events.app_deliveries WHERE subscription_id=${context.subscriptionId}
            AND event_id=${envelope.id}::uuid AND code='workload_replay')) AS recoverable
        FROM code.runs WHERE id=${receipt.run_id}::uuid FOR UPDATE`;
      if (!run?.recoverable) return;
      recoverRun = run.id;
    }
    if (!receipt) {
      const [historical] = await db`SELECT run_id FROM code.run_requests WHERE code_id=${code.id}
        AND request_key=${`historical:${codeEventTargetKey(code.activeVersionId, envelope)}`}`;
      if (historical) {
        await db`INSERT INTO code.run_requests(code_id,request_key,run_id) VALUES(${code.id},${requestKey},${historical.run_id}::uuid)`;
        return;
      }
    }
    const [delivery] = await db<{ seq: string; subject_key: string }[]>`SELECT seq,subject_key FROM events.app_deliveries
      WHERE subscription_id=${context.subscriptionId} AND event_id=${envelope.id}::uuid FOR SHARE`;
    if (!delivery) return { cancelled: true as const };
    const [version] = await db<{ manifest: unknown }[]>`SELECT manifest FROM code.versions WHERE id=${code.activeVersionId}::uuid`;
    const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
    const entry = codeEventEntry(manifest, envelope);
    if (!entry?.event || entry.event.place.type !== binding.place.type || entry.event.place.id !== binding.place.id)
      return { cancelled: true as const };
    await requireCodeVersionApproval(code, code.activeVersionId, db);
    const [waiting] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM code.runs
      WHERE code_id=${code.id} AND trigger='event' AND state IN ('queued','running')`;
    if ((waiting?.count ?? 0) >= backlog) throw new Error("code_event_backlog_full");
    context.signal.throwIfAborted();
    const runId =
      recoverRun ??
      (await insertCodeRun(
        {
          codeId: code.id,
          versionId: code.activeVersionId,
          trigger: "event",
          entrypoint: entry.entrypoint,
          input: AppEventEnvelopeSchema.parse(envelope),
        },
        db,
      ));
    if (recoverRun) {
      // Only a never-started run can be explicitly rebound. Completed or attempted runs retain their receipt and effects.
      await db`UPDATE code.runs SET version_id=${code.activeVersionId}::uuid,entrypoint=${entry.entrypoint},state='queued',outcome=NULL,ended_at=NULL
        WHERE id=${runId}::uuid`;
      await db`INSERT INTO code.run_outbox(run_id) VALUES(${runId}::uuid) ON CONFLICT DO NOTHING`;
    } else await db`INSERT INTO code.run_requests(code_id,request_key,run_id) VALUES(${code.id},${requestKey},${runId}::uuid)`;
    await db`UPDATE code.runs SET event_subject_key=${`${binding.place.type}:${binding.place.id}`},event_sequence=(SELECT sequence FROM code.run_outbox WHERE run_id=${runId}::uuid) WHERE id=${runId}::uuid`;
    await db`INSERT INTO code.run_requests(code_id,request_key,run_id)
      VALUES(${code.id},${codeEventTargetKey(code.activeVersionId, envelope)},${runId}::uuid) ON CONFLICT DO NOTHING`;
    context.signal.throwIfAborted();
  });
}
/** One historical execution per immutable version and message; live admission also reserves this identity.
 * Hash scalar fields: JSONB can reorder the subject object's properties between catch-up and live delivery.
 */
export const codeEventTargetKey = (versionId: string, envelope: AppEventEnvelope) =>
  `catchup:${versionId}:${new Bun.CryptoHasher("sha256").update(JSON.stringify([envelope.type, envelope.version, envelope.subject.type, envelope.subject.id])).digest("hex")}`;

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
    SELECT delivery.id,delivery.event_id AS "eventId",event.type AS "eventType",
      CASE WHEN delivery.state IN ('done','cancelled') THEN 'failed' ELSE delivery.state END AS state,
      CASE WHEN delivery.state='done' THEN 'code_not_active' WHEN delivery.last_error='code_event_backlog_full' THEN delivery.last_error ELSE delivery.code END AS code,delivery.attempts,
      to_char(delivery.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM events.app_deliveries delivery JOIN events.app_subscriptions subscription ON subscription.id=delivery.subscription_id
    JOIN events.app_events event ON event.id=delivery.event_id
    LEFT JOIN code.run_requests receipt ON receipt.code_id=${codeId} AND receipt.request_key='event:'||event.id::text
    LEFT JOIN code.runs run ON run.id=receipt.run_id
    WHERE subscription.resource_binding->>'consumer'=${CODE_EVENT_CONSUMER} AND subscription.resource_binding->>'key'=${codeId}
      AND delivery.code IS DISTINCT FROM 'workload_replayed'
      AND event.received_at>=clock_timestamp()-interval '30 days'
      AND (delivery.state IN ('pending','retrying','failed') OR (delivery.state='cancelled' AND delivery.code IN ('workload_changed','resource_access_revoked'))
        OR (delivery.state='done' AND run.state='failed' AND run.outcome='code_not_active' AND run.generation=0 AND run.started_at IS NULL AND NOT run.effect_started))
      ORDER BY (delivery.state NOT IN ('pending','retrying')) DESC,delivery.seq ASC LIMIT 20`;
}
/** Deliberate retry of delivery only; the permanent event receipt prevents repeating an admitted run. */
export async function replayCodeEventDelivery(codeId: string, deliveryId: string, context: CodeContext) {
  codePerson(context, true);
  const { permission } = await readCode(codeId, context);
  if (permission !== "editor") throw new CodeDataError("FORBIDDEN", "Only Code editors may retry delivery.");
  return sql.begin(async (db) => {
    await db`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
    const code = await findCode(codeId, db);
    if (!code || code.state !== "active") throw new CodeDataError("CONFLICT", "Code must be active.");
    const [delivery] = await db`SELECT delivery.id FROM events.app_deliveries delivery
      JOIN events.app_subscriptions subscription ON subscription.id=delivery.subscription_id
      LEFT JOIN code.run_requests receipt ON receipt.code_id=${codeId} AND receipt.request_key='event:'||delivery.event_id::text
      LEFT JOIN code.runs run ON run.id=receipt.run_id
      WHERE delivery.id=${deliveryId}::uuid AND (delivery.state='failed' OR (delivery.state='cancelled' AND delivery.code IN ('workload_changed','resource_access_revoked'))
        OR (delivery.state='done' AND run.state='failed' AND run.outcome='code_not_active' AND run.generation=0 AND run.started_at IS NULL AND NOT run.effect_started))
        AND subscription.resource_binding->>'consumer'=${CODE_EVENT_CONSUMER} AND subscription.resource_binding->>'key'=${codeId}
      FOR UPDATE OF delivery`;
    if (!delivery) throw new CodeDataError("CONFLICT", "The failed delivery is no longer available for retry.");
    const id = await replayResourceEventDelivery(db, String(delivery.id), CODE_EVENT_CONSUMER, codeId);
    if (!id) throw new CodeDataError("CONFLICT", "The event or matching current registration is unavailable for retry.");
    await audit.record(
      {
        action: "core.code.event.redeliver",
        outcome: "allowed",
        actor: { userId: codePerson(context, true).id },
        target: { type: "code", id: codeId },
        metadata: { deliveryId: id, previousDeliveryId: deliveryId },
      },
      db,
    );
    return { deliveryId: id };
  });
}

export async function listCodeRunsWithEvents(input: Parameters<typeof listCodeRuns>[0], context: CodeContext) {
  const runs = await listCodeRuns(input, context);
  return { ...runs, eventDeliveries: await listCodeEventDeliveries(input.codeId) };
}
