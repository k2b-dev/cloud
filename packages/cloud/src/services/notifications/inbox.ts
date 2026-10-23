import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import {
  NotificationInboxContentSchema,
  NotificationInboxQuerySchema,
  type NotificationInboxResponse,
} from "../../contracts/notification-inbox";
import type { RequestAuthority } from "../../server/middleware/auth";
import { decryptSecret } from "../secrets";
import { isStandaloneServiceAccountKind } from "../service-accounts";

type InboxRow = {
  id: string;
  event_id: string;
  definition_id: string;
  app_id: string;
  created_at: Date;
  delivered_at: Date;
  payload_encrypted: string;
};

const list = async (input: {
  authority: RequestAuthority;
  page?: number;
  perPage?: number;
}): Promise<Result<NotificationInboxResponse>> => {
  const { actor, accessSubject, credentialKind, scopes } = input.authority;
  // An inbox belongs to the actor, never its creator or delegated human.
  // Resource keys additionally see only notices for their exact binding.
  if (
    actor.kind !== "service_account" ||
    actor.delegatedUser !== null ||
    actor.serviceAccount.status !== "active" ||
    actor.serviceAccount.delegatedUserId !== null ||
    (actor.serviceAccount.kind === "resource_bound"
      ? !actor.serviceAccount.appId || !actor.serviceAccount.resourceType || !actor.serviceAccount.resourceId
      : !isStandaloneServiceAccountKind(actor.serviceAccount.kind) ||
        actor.serviceAccount.appId !== null ||
        actor.serviceAccount.resourceType !== null ||
        actor.serviceAccount.resourceId !== null) ||
    accessSubject.type !== "service_account" ||
    accessSubject.serviceAccountId !== actor.serviceAccount.id ||
    (credentialKind !== "api_key" && credentialKind !== "oauth")
  ) {
    return fail(err.forbidden("A non-delegated service-account actor must read its own inbox"));
  }
  // Both the request authority and the credential must explicitly allow reads.
  const canRead = (values: readonly string[]) => values.includes("read") || values.includes("admin");
  if (!canRead(scopes) || !canRead(actor.scopes)) {
    return fail(err.forbidden("The read scope is required to read notification inbox content"));
  }
  const query = NotificationInboxQuerySchema.safeParse({ page: input.page, perPage: input.perPage });
  if (!query.success) return fail(err.badInput("Invalid notification inbox pagination"));
  const { page, perPage } = query.data;
  const recipientId = actor.serviceAccount.id;
  const [counts, rows] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      JOIN notifications.definitions n ON n.id = e.definition_id
      JOIN auth.service_accounts a ON a.id = e.recipient_service_account_id
      WHERE a.id = ${recipientId}::uuid AND a.status = 'active' AND a.kind = ${actor.serviceAccount.kind}
        AND a.app_id IS NOT DISTINCT FROM ${actor.serviceAccount.appId}
        AND a.resource_type IS NOT DISTINCT FROM ${actor.serviceAccount.resourceType}
        AND a.resource_id IS NOT DISTINCT FROM ${actor.serviceAccount.resourceId}
        AND (a.kind <> 'resource_bound' OR (n.app_id = a.app_id AND e.resource_type = a.resource_type AND e.resource_id = a.resource_id))
        AND d.channel = 'inbox' AND d.status = 'delivered'
    `,
    sql<InboxRow[]>`
      SELECT d.id, d.event_id, e.definition_id, n.app_id, e.created_at, d.delivered_at, d.payload_encrypted
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      JOIN notifications.definitions n ON n.id = e.definition_id
      JOIN auth.service_accounts a ON a.id = e.recipient_service_account_id
      WHERE a.id = ${recipientId}::uuid AND a.status = 'active' AND a.kind = ${actor.serviceAccount.kind}
        AND a.app_id IS NOT DISTINCT FROM ${actor.serviceAccount.appId}
        AND a.resource_type IS NOT DISTINCT FROM ${actor.serviceAccount.resourceType}
        AND a.resource_id IS NOT DISTINCT FROM ${actor.serviceAccount.resourceId}
        AND (a.kind <> 'resource_bound' OR (n.app_id = a.app_id AND e.resource_type = a.resource_type AND e.resource_id = a.resource_id))
        AND d.channel = 'inbox' AND d.status = 'delivered'
      ORDER BY e.created_at DESC, e.id DESC, d.id DESC
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `,
  ]);
  const total = Number(counts[0]?.count ?? 0);
  const items = await Promise.all(
    rows.map(async (row) => ({
      ...NotificationInboxContentSchema.parse(await decryptSecret(row.payload_encrypted)),
      id: row.id,
      eventId: row.event_id,
      definitionId: row.definition_id,
      appId: row.app_id,
      createdAt: row.created_at.toISOString(),
      deliveredAt: row.delivered_at.toISOString(),
    })),
  );
  return ok({ items, total, page, perPage, totalPages: total === 0 ? 0 : Math.ceil(total / perPage) });
};

export const notificationInbox = { list } as const;
