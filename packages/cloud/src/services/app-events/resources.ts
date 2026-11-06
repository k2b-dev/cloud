import type { SQL } from "bun";
import { z } from "zod";
import { capabilityHash } from "../../_internal/capability-schemas";
import { getCapability } from "../../_internal/registry";
import { readCapabilityResponse } from "../../capabilities/response";
import type { AppEventDeliveryContext, AppEventEnvelope } from "../../contracts/app-events";
import {
  CapabilityAppIdSchema,
  CapabilityQualifiedIdSchema,
  CloudResourceRefSchema,
  capabilityResultSchema,
} from "../../contracts/capabilities";
import { AppAccessDeniedError } from "../../server/middleware/app-access";
import { issueInvocationToken, resolveIssuanceAuthority } from "../identity/issue-invocation";
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
    mandate.ownerAppId !== appId ||
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
  const response = await fetch(`${provider.endpoint}/queries/${encodeURIComponent(reader)}`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${signed.token}`, "content-type": "application/json" },
    body: JSON.stringify({ input: { id: binding.place.id } }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const result = await readCapabilityResponse(response, capabilityResultSchema(z.unknown(), { consumer: true }), undefined, signal);
  if (result.ok) return true;
  if (["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"].includes(result.error.code)) return false;
  throw new Error(`Resource event reader unavailable: ${result.error.code}`);
}
