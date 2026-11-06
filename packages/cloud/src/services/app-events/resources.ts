import type { SQL } from "bun";
import { z } from "zod";
import { capabilityHash } from "../../_internal/capability-schemas";
import { createCapabilityDeadline } from "../../_internal/capability-timeout";
import { getCapability } from "../../_internal/registry";
import { readCapabilityResponse } from "../../capabilities/response";
import type { AppEventDeliveryContext, AppEventEnvelope } from "../../contracts/app-events";
import {
  CAPABILITY_ORIGIN_HEADER,
  CapabilityAppIdSchema,
  CapabilityQualifiedIdSchema,
  CloudResourceRefSchema,
  capabilityResultSchema,
} from "../../contracts/capabilities";
import { AppAccessDeniedError } from "../../server/middleware/app-access";
import { issueInvocationToken, requireRegisteredAppAccess, resolveIssuanceAuthority } from "../identity/issue-invocation";
import { NESTED_INVOCATION_SETUP_BUDGET_MS, nestedInvocationLeases } from "../identity/nested-invocation";
import { logger } from "../logging";
import { mandates } from "../mandates";

/** Core-owned workloads bind one immutable revision, mandate and exact place. Never browser input. */
export const ResourceEventBindingSchema = z
  .object({
    consumer: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9.-]*$/),
    key: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    mandateId: z.uuid(),
    mandateOwnerAppId: CapabilityAppIdSchema,
    mandateRevision: z.number().int().positive(),
    place: CloudResourceRefSchema,
  })
  .strict();
export type ResourceEventBinding = z.infer<typeof ResourceEventBindingSchema>;
export type ResourceEventConsumer = (
  binding: ResourceEventBinding,
  envelope: AppEventEnvelope,
  context: AppEventDeliveryContext,
) => Promise<void | { cancelled: true }>;

// Runtime implementations are installed by Core; the subscription and all work remain in Postgres.
const consumers = new Map<string, ResourceEventConsumer>();
export function registerResourceEventConsumer(name: string, consumer: ResourceEventConsumer): () => void {
  if (consumers.has(name)) throw new Error(`Resource event consumer already registered: ${name}`);
  consumers.set(name, consumer);
  return () => {
    if (consumers.get(name) === consumer) consumers.delete(name);
  };
}
export const resourceEventConsumer = (name: string) => consumers.get(name);

/** Call inside the workload's activation transaction. No historical events are implicitly replayed. */
export async function subscribeResourceEvent(
  db: SQL,
  input: {
    appId: string;
    type: string;
    version: number;
    binding: ResourceEventBinding;
  },
): Promise<string> {
  const appId = CapabilityAppIdSchema.parse(input.appId);
  const type = CapabilityQualifiedIdSchema.parse(input.type);
  const version = z.number().int().positive().parse(input.version);
  const binding = ResourceEventBindingSchema.parse(input.binding);
  const id = `resource:${appId}:${capabilityHash({ type, version, binding })}`;
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`cloud.resource-event:${type}@${version}`},0))`;
  await db`INSERT INTO events.app_subscriptions(id,app_id,event_type,version,state,reason,resource_binding,first_seen_at)
    VALUES(${id},${appId},${type},${version},'active',NULL,${JSON.stringify(binding)}::text::jsonb,clock_timestamp())
    ON CONFLICT(id) DO NOTHING`;
  const [stored] = await db`SELECT state FROM events.app_subscriptions WHERE id=${id} FOR SHARE`;
  if (stored?.state !== "active") throw new Error("Resource subscription is cancelled; resume with a fresh revision");
  return id;
}

/** Cancel under the same workload lock used for activation/admission. Already admitted effects are separate work. */
export async function cancelResourceEventSubscriptions(db: SQL, consumer: string, key: string): Promise<void> {
  await db`UPDATE events.app_subscriptions SET state='cancelled',reason='workload_changed',updated_at=now()
    WHERE resource_binding->>'consumer'=${consumer} AND resource_binding->>'key'=${key} AND state<>'cancelled'`;
  await db`UPDATE events.app_deliveries delivery SET state='cancelled',code='workload_changed',claim_token=NULL,
    claimed_until=NULL,updated_at=now() FROM events.app_subscriptions subscription
    WHERE subscription.id=delivery.subscription_id AND subscription.resource_binding->>'consumer'=${consumer}
      AND subscription.resource_binding->>'key'=${key} AND subscription.state='cancelled'
      AND delivery.state IN ('pending','retrying','failed')`;
}

/** Deliberate workload recovery within event retention. The caller authorizes the workload and holds its activation lock. */
export async function replayResourceEventDelivery(db: SQL, deliveryId: string, consumer: string, key: string): Promise<string | null> {
  const [source] = await db<
    {
      event_id: string;
      subscription_id: string;
      subject_key: string;
      resource_binding: ResourceEventBinding;
      event_type: string;
      version: number;
    }[]
  >`
    SELECT delivery.event_id,delivery.subscription_id,delivery.subject_key,subscription.resource_binding,subscription.event_type,subscription.version
    FROM events.app_deliveries delivery JOIN events.app_subscriptions subscription ON subscription.id=delivery.subscription_id
    JOIN events.app_events event ON event.id=delivery.event_id
    WHERE delivery.id=${deliveryId}::uuid AND subscription.resource_binding->>'consumer'=${consumer}
      AND subscription.resource_binding->>'key'=${key} AND event.state='accepted'
      AND event.received_at>=clock_timestamp()-interval '30 days'
      AND delivery.state IN ('failed','cancelled','done') FOR UPDATE OF delivery`;
  if (!source) return null;
  const [current] = await db<{ id: string }[]>`SELECT id FROM events.app_subscriptions
    WHERE state='active' AND resource_binding->>'consumer'=${consumer} AND resource_binding->>'key'=${key}
      AND resource_binding->'place'=${JSON.stringify(source.resource_binding.place)}::text::jsonb
      AND event_type=${source.event_type} AND version=${source.version} FOR SHARE`;
  if (!current) return null;
  const [delivery] = await db<{ id: string }[]>`INSERT INTO events.app_deliveries(id,subscription_id,event_id,subject_key)
    VALUES(gen_random_uuid(),${current.id},${source.event_id}::uuid,${source.subject_key})
    ON CONFLICT(subscription_id,event_id) DO UPDATE SET state='pending',code=NULL,last_error=NULL,
      attempts=0,unreachable_count=0,claimed_until=NULL,claim_token=NULL,next_attempt_at=now(),retained_from=now(),updated_at=now()
    WHERE events.app_deliveries.state IN ('failed','cancelled','done') RETURNING id`;
  if (!delivery) return null;
  if (source.subscription_id !== current.id)
    await db`UPDATE events.app_deliveries SET code='workload_replayed',updated_at=now() WHERE id=${deliveryId}::uuid`;
  return delivery.id;
}

/** Permission checks use the place's ordinary Type reader. They grant no permission to the handler. */
export async function authorizeResourceEvent(
  appId: string,
  binding: ResourceEventBinding,
  envelope: AppEventEnvelope,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (envelope.place?.type !== binding.place.type || envelope.place.id !== binding.place.id) return false;
  const mandate = await mandates.get(binding.mandateId);
  if (
    !mandate ||
    mandate.ownerAppId !== binding.mandateOwnerAppId ||
    mandate.state !== "active" ||
    !mandate.confirmedAt ||
    mandate.revision !== binding.mandateRevision ||
    (mandate.expiresAt && Date.parse(mandate.expiresAt) <= Date.now())
  )
    return false;
  const principal = {
    sub: mandate.subject.id,
    principal_type: mandate.subject.type,
    access_subject_type: mandate.subject.type,
    access_subject_id: mandate.subject.id,
    credential_kind: "mandate",
    scopes: [],
    mandate_id: mandate.id,
    mandate_revision: mandate.revision,
    workload_type: mandate.workloadType,
    workload_id: mandate.workloadId,
    workload_event: envelope.id,
  } as const;
  const authority = await resolveIssuanceAuthority({ ...principal, scopes: [] }, appId);
  if (!authority) return false;
  try {
    await requireRegisteredAppAccess(authority, appId, { signal });
  } catch (error) {
    if (error instanceof AppAccessDeniedError) return false;
    throw error;
  }
  signal?.throwIfAborted();
  const separator = binding.place.type.indexOf(".");
  const source = binding.place.type.slice(0, separator);
  const localType = binding.place.type.slice(separator + 1);
  const provider = await getCapability(source);
  if (!provider) throw new Error("Resource event reader unavailable");
  const reader = provider.manifest.types.find((type) => type.localId === localType)?.reader;
  if (!reader) return false;
  const operation = provider.manifest.queries.find((query) => query.localId === reader);
  if (!operation || operation.stream) return false;
  let signed: Awaited<ReturnType<typeof issueInvocationToken>>;
  try {
    signed = await issueInvocationToken(
      {
        targetAppId: source,
        callingAppId: appId,
        operation: `capability.query:${reader}`,
        schemaHash: operation.schemaHash,
        authority: { ...principal, scopes: [] },
      },
      { signal },
    );
  } catch (error) {
    if (error instanceof AppAccessDeniedError) return false;
    throw error;
  }
  const budget = signal ?? AbortSignal.timeout(30_000);
  const setup = createCapabilityDeadline(NESTED_INVOCATION_SETUP_BUDGET_MS, budget);
  try {
    await setup.wait(() =>
      nestedInvocationLeases.create(signed.claims, { appId: source, deadline: signed.claims.exp * 1000, origin: "app" }, setup.signal),
    );
  } finally {
    setup.clear();
  }
  try {
    const response = await fetch(`${provider.endpoint}/queries/${encodeURIComponent(reader)}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${signed.token}`,
        "content-type": "application/json",
        "x-cloud-capability-schema-hash": operation.schemaHash,
        [CAPABILITY_ORIGIN_HEADER]: "app",
      },
      body: JSON.stringify({ input: { id: binding.place.id } }),
      signal: budget,
    });
    const result = await readCapabilityResponse(response, capabilityResultSchema(z.unknown(), { consumer: true }), undefined, budget);
    if (result.ok) return true;
    if (["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(result.error.code)) return false;
    throw new Error(`Resource event reader unavailable: ${result.error.code}`);
  } finally {
    await nestedInvocationLeases
      .revoke(signed.claims.jti)
      .catch(() => logger("app-events:broker").warn("Resource visibility lease cleanup failed"));
  }
}
