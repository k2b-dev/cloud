import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { env } from "@k2b/cloud/config";
import { logger, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { ShortIdSchema } from "./contracts";

const log = logger("chat:system-notifications");
const ReaderResult = z.object({ readable: z.array(z.uuid()).max(500) });
export const systemNotificationDependencies = {
  invoke: (appId: string, capabilityId: string, input: { id: string; userIds: string[] }, caller: CapabilityCaller) =>
    invokeCapabilityWithDataSchema({ kind: "query", appId, capabilityId, input }, ReaderResult, caller),
};
export const systemNotificationHealth = () => ({
  status: env.CLOUD_APP_CREDENTIAL && env.CLOUD_CORE_INTERNAL_ORIGIN ? ("configured" as const) : ("unavailable" as const),
  reason: env.CLOUD_APP_CREDENTIAL && env.CLOUD_CORE_INTERNAL_ORIGIN ? null : "Configure Chat's workload credential and direct Core origin",
});
export const reportSystemNotificationHealth = () => {
  const health = systemNotificationHealth();
  if (health.status !== "configured") log.warn("System chat notifications unavailable", { reason: health.reason });
};

/** No permission cache: delivery, badge reads and the final send all ask the owner afresh. */
export const readableSystemRecipients = async (
  conversationId: string,
  threadId: string | null,
  userIds: readonly string[],
  db: typeof sql = sql,
): Promise<Set<string>> => {
  const ids = z.array(z.uuid()).max(500).parse(userIds);
  if (!ids.length || threadId === null) return new Set();
  if (systemNotificationHealth().status !== "configured") {
    reportSystemNotificationHealth();
    return new Set();
  }
  const [resource] = await db<{ resource_type: string; resource_id: string }[]>`
    SELECT t.resource_type, t.resource_id FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id
    WHERE t.id = ${threadId}::uuid AND c.id = ${conversationId}::uuid AND c.kind = 'system'
      AND ((c.resource_type = 'spaces.space' AND t.resource_type = 'spaces.item')
        OR (c.resource_type = 'notebooks.notebook' AND t.resource_type = 'notebooks.note'))
  `;
  if (!resource || !ShortIdSchema.safeParse(resource.resource_id).success) return new Set();
  // Resolve the exact thread first, then filter the candidates locally. Never forward caller-chosen people.
  const candidates = await db<{ id: string }[]>`
    SELECT u.id FROM auth.users u WHERE u.id = ANY(${toPgUuidArray(ids)}::uuid[])
      AND (u.account_expires IS NULL OR u.account_expires > now())
      AND (EXISTS(SELECT 1 FROM chat.participants p WHERE p.conversation_id = ${conversationId}::uuid AND p.principal_type = 'user' AND p.principal_id = u.id)
        OR EXISTS(SELECT 1 FROM chat.thread_follows f WHERE f.thread_id = ${threadId}::uuid AND f.principal_type = 'user' AND f.principal_id = u.id))
  `;
  if (!candidates.length) return new Set();
  const [appId, element] = resource.resource_type.split(".");
  const result = await systemNotificationDependencies.invoke(
    appId!,
    `${element}.readable`,
    { id: resource.resource_id, userIds: candidates.map((row) => row.id) },
    {
      workload: { appId: "chat" },
      authorization: `Bearer ${env.CLOUD_APP_CREDENTIAL}`,
    },
  );
  if (!result.ok) {
    log.warn("System chat reader check failed", { appId, code: result.error.code, status: result.error.status });
    // Do not acknowledge pending delivery on an infrastructure failure. The existing jobs retry visibly.
    if (result.error.status !== 403 && result.error.status !== 404) throw new Error("System chat reader check unavailable");
    return new Set();
  }
  const eligible = new Set(candidates.map((row) => row.id));
  return new Set(result.data.data.readable.filter((id) => eligible.has(id)));
};
