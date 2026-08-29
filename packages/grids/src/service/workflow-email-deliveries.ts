import { err } from "@k2b/stdlib";
import { toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { GridsWorkflowEmailDelivery as WorkflowEmailDelivery } from "../workflows/contracts";
import type { SqlClient } from "./audit";
import { workflowConflict } from "./workflow-errors";
import { workflowServiceText } from "./workflow-service-messages";

type DeliveryStatus = "pending" | "sent" | "failed";

type DeliveryIntentInput = {
  baseId: string;
  workflowId: string;
  workflowRunId: string;
  workflowStepKey: string;
  templateId: string;
  recipientIndex: number;
  recipientKind: "email" | "user";
  recipientValue: string;
  recipientSummary: string;
  idempotencyKey: string;
  subject: string;
  renderedHtml: string;
  locale?: string;
};

type DeliveryRow = {
  id: string;
  workflow_id: string | null;
  workflow_run_id: string | null;
  template_id: string | null;
  recipient_kind: "email" | "user";
  recipient_summary: string;
  notification_id: string | null;
  provider_status: string | null;
  status: DeliveryStatus;
  subject: string | null;
  error: string | null;
  created_at: Date | string;
  cursor_token: string;
};

export type WorkflowEmailDeliveryIntent = WorkflowEmailDelivery & {
  recipientValue: string | null;
  idempotencyKey: string;
  renderedHtml: string | null;
  providerStatus: string | null;
  notificationId: string | null;
};

const toIsoString = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const mapDelivery = (row: DeliveryRow): WorkflowEmailDelivery => ({
  id: row.id,
  workflowId: row.workflow_id,
  workflowRunId: row.workflow_run_id,
  templateId: row.template_id,
  subject: row.subject,
  recipients: [
    {
      kind: row.recipient_kind,
      recipient: row.recipient_summary,
      ...(row.notification_id ? { notificationId: row.notification_id } : {}),
      ...(row.provider_status ? { status: row.provider_status } : {}),
    },
  ],
  status: row.status,
  error: row.error,
  createdAt: toIsoString(row.created_at),
});

const mapIntent = (
  row: DeliveryRow & { recipient_value: string | null; idempotency_key: string; rendered_html: string | null },
): WorkflowEmailDeliveryIntent => ({
  ...mapDelivery(row),
  recipientValue: row.recipient_value,
  idempotencyKey: row.idempotency_key,
  renderedHtml: row.rendered_html,
  providerStatus: row.provider_status,
  notificationId: row.notification_id,
});

type DeliveryIntentRow = DeliveryRow & {
  recipient_value: string | null;
  idempotency_key: string;
  rendered_html: string | null;
};

const intentColumns = sql`
  id, workflow_id, workflow_run_id, template_id, recipient_kind, recipient_value, recipient_summary,
  notification_id, provider_status, status, subject, rendered_html, idempotency_key, error, created_at,
  (created_at::text || '|' || id::text) AS cursor_token
`;

export const getWorkflowEmailDeliveryIntent = async (
  workflowRunId: string,
  workflowStepKey: string,
  recipientIndex: number,
  client: SqlClient = sql,
): Promise<WorkflowEmailDeliveryIntent | null> => {
  const [row] = await client<DeliveryIntentRow[]>`
    SELECT ${intentColumns}
    FROM grids.workflow_email_deliveries
    WHERE workflow_run_id = ${workflowRunId}::uuid
      AND workflow_step_key = ${workflowStepKey}
      AND recipient_index = ${recipientIndex}
  `;
  return row ? mapIntent(row) : null;
};

export const getOrCreateWorkflowEmailDeliveryIntent = async (
  input: DeliveryIntentInput,
  client: SqlClient = sql,
): Promise<WorkflowEmailDeliveryIntent> => {
  const rows = await client<DeliveryIntentRow[]>`
    INSERT INTO grids.workflow_email_deliveries (
      base_id, workflow_id, workflow_run_id, workflow_step_key, template_id, recipient_index,
      recipient_kind, recipient_value, recipient_summary, idempotency_key, status, subject, rendered_html
    )
    VALUES (
      ${input.baseId}::uuid, ${input.workflowId}::uuid, ${input.workflowRunId}::uuid,
      ${input.workflowStepKey}, ${input.templateId}::uuid, ${input.recipientIndex},
      ${input.recipientKind}, ${input.recipientValue}, ${input.recipientSummary}, ${input.idempotencyKey},
      'pending', ${input.subject}, ${input.renderedHtml}
    )
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING ${intentColumns}
  `;
  const [row] = rows.length
    ? rows
    : await client<DeliveryIntentRow[]>`
        SELECT ${intentColumns}
        FROM grids.workflow_email_deliveries
        WHERE idempotency_key = ${input.idempotencyKey}
      `;
  if (!row) throw err.internal(workflowServiceText(input.locale).emailIntentInsertFailed);
  if (
    row.workflow_run_id !== input.workflowRunId ||
    row.template_id !== input.templateId ||
    row.recipient_kind !== input.recipientKind ||
    row.recipient_value !== input.recipientValue ||
    row.subject !== input.subject ||
    row.rendered_html !== input.renderedHtml
  ) {
    throw workflowConflict(workflowServiceText(input.locale).emailIntentMismatch);
  }
  return mapIntent(row);
};

export const finishWorkflowEmailDeliveryIntent = async (
  deliveryId: string,
  input: { notificationId: string | null; providerStatus: string; status: "sent" | "failed"; error?: string | null },
  client: SqlClient = sql,
  locale?: string,
): Promise<{ delivery: WorkflowEmailDeliveryIntent; transitioned: boolean }> => {
  const [row] = await client<DeliveryIntentRow[]>`
    UPDATE grids.workflow_email_deliveries
    SET notification_id = COALESCE(notification_id, ${input.notificationId}::uuid),
        provider_status = ${input.providerStatus},
        status = ${input.status},
        error = ${input.error ?? null},
        recipient_value = NULL,
        rendered_html = NULL,
        updated_at = now()
    WHERE id = ${deliveryId}::uuid
      AND status = 'pending'
    RETURNING ${intentColumns}
  `;
  if (row) return { delivery: mapIntent(row), transitioned: true };
  const [existing] = await client<DeliveryIntentRow[]>`
    SELECT ${intentColumns}
    FROM grids.workflow_email_deliveries
    WHERE id = ${deliveryId}::uuid
  `;
  if (!existing) throw { ...err.notFound("workflow email delivery intent"), message: workflowServiceText(locale).emailIntentNotFound };
  return { delivery: mapIntent(existing), transitioned: false };
};

// ─── Reading the delivery history ────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type DeliveryCursor = { createdAt: string; id: string };

const parseCursor = (cursor: string | null | undefined): DeliveryCursor | null => {
  if (!cursor) return null;
  const [createdAt, id, ...rest] = cursor.split("|");
  if (!createdAt || !id || rest.length > 0 || !Number.isFinite(Date.parse(createdAt))) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return { createdAt, id };
};

const pageSize = (limit: number | null | undefined): number => Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

/**
 * What a workflow sent, with the provider's verdict folded in.
 *
 * The intent row records that a step asked for a mail; whether it arrived is
 * the notification service's answer, and it changes after the step finished.
 * So a delivery still marked pending here is reported by what its notification
 * became — otherwise the run view would claim "pending" forever for mail that
 * bounced hours ago.
 */
export const listWorkflowEmailDeliveriesPage = async (params: {
  baseId: string;
  workflowIds: string[];
  workflowId?: string | null;
  cursor?: string | null;
  limit?: number | null;
}): Promise<{ items: WorkflowEmailDelivery[]; nextCursor: string | null }> => {
  if (params.workflowIds.length === 0) return { items: [], nextCursor: null };
  const cap = pageSize(params.limit);
  const workflowIds = toPgUuidArray(params.workflowIds);
  const cursor = parseCursor(params.cursor);
  const workflowClause = params.workflowId ? sql`AND delivery.workflow_id = ${params.workflowId}::uuid` : sql``;
  const cursorClause = cursor
    ? sql`AND (delivery.created_at, delivery.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
    : sql``;
  const rows = await sql<DeliveryRow[]>`
    SELECT delivery.id, delivery.workflow_id, delivery.workflow_run_id, delivery.template_id,
           delivery.recipient_kind, delivery.recipient_summary, delivery.notification_id,
           COALESCE(notification_state.provider_status, delivery.provider_status) AS provider_status,
           CASE
             WHEN delivery.status = 'failed' THEN 'failed'
             WHEN notification_state.current_status IS NOT NULL THEN notification_state.current_status
             ELSE delivery.status
           END AS status,
           delivery.subject,
           COALESCE(delivery.error, notification_state.error) AS error,
           delivery.created_at,
           (delivery.created_at::text || '|' || delivery.id::text) AS cursor_token
    FROM grids.workflow_email_deliveries delivery
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN bool_or(required AND status IN ('failed', 'suppressed')) THEN 'failed'
          WHEN bool_or(required AND status IN ('deferred', 'pending', 'sending')) THEN 'pending'
          ELSE 'sent'
        END AS current_status,
        string_agg(DISTINCT status, ', ' ORDER BY status) AS provider_status,
        max(CASE WHEN required AND status IN ('failed', 'suppressed') THEN COALESCE(error_message, error_code) END) AS error
      FROM notifications.deliveries
      WHERE event_id = delivery.notification_id
    ) notification_state ON delivery.notification_id IS NOT NULL
    WHERE delivery.base_id = ${params.baseId}::uuid
      AND delivery.workflow_id = ANY(${workflowIds}::uuid[])
      ${workflowClause}
      ${cursorClause}
    ORDER BY delivery.created_at DESC, delivery.id DESC
    LIMIT ${cap + 1}
  `;
  return {
    items: rows.slice(0, cap).map(mapDelivery),
    nextCursor: rows.length > cap ? (rows[cap - 1]?.cursor_token ?? null) : null,
  };
};
