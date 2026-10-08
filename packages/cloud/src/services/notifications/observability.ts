import { type SQL, sql } from "bun";
import type { MailStatus } from "../../contracts/outgoing-mail";
import type { NotificationDeliveryStatus } from "../../contracts/user-notifications";
import { escapeLikePattern, toPgTextArray } from "../postgres";

const DELIVERY_STATUSES = new Set<NotificationDeliveryStatus>(["deferred", "pending", "sending", "delivered", "suppressed", "failed"]);

export type NotificationDeliveryObservabilityItem = {
  id: string;
  eventId: string;
  definitionId: string;
  appId: string;
  kind: string;
  label: string;
  title: string;
  targetHref: string | null;
  recipientLabel: string;
  recipientReference: string;
  channel: string;
  destinationLabel: string;
  required: boolean;
  routePriority: number | null;
  status: NotificationDeliveryStatus;
  outgoingMailId: string | null;
  outgoingMailStatus: MailStatus | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  deliveredAt: Date | null;
};

export type NotificationDeliveryTimeseriesPoint = {
  at: Date;
  total: number;
  active: number;
  delivered: number;
  suppressed: number;
  failed: number;
};

export type NotificationDefinitionObservabilityItem = {
  id: string;
  appId: string;
  kind: string;
  label: string;
  description: string;
  recipientKind: "user" | "email";
  recommendedChannels: string[];
  requiredChannels: string[];
  active: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  updatedAt: Date;
  eventCount7d: number;
  failedDeliveryCount7d: number;
};

type PageInput = { page?: number; perPage?: number };
type PageResult<T> = { items: T[]; page: number; perPage: number; total: number; hasNext: boolean };
type DeliveryFilter = {
  search?: string;
  statuses?: readonly NotificationDeliveryStatus[];
  channels?: readonly string[];
  appIds?: readonly string[];
};

type DeliveryRow = {
  id: string;
  event_id: string;
  definition_id: string;
  app_id: string;
  kind: string;
  label: string;
  title: string;
  target_href: string | null;
  recipient_label: string;
  recipient_reference: string;
  channel: string;
  destination_label: string;
  required: boolean;
  route_priority: number | null;
  status: NotificationDeliveryStatus;
  outgoing_mail_id: string | null;
  outgoing_mail_status: MailStatus | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
};

type DefinitionRow = {
  id: string;
  app_id: string;
  kind: string;
  label: string;
  description: string;
  recipient_kind: "user" | "email";
  recommended_channels: string[];
  required_channels: string[];
  active: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  updated_at: Date;
  event_count_7d: number;
  failed_delivery_count_7d: number;
};

const normalizePage = (input: PageInput): { page: number; perPage: number; offset: number } => {
  const page = Number.isFinite(input.page) ? Math.max(1, Math.trunc(input.page ?? 1)) : 1;
  const perPage = Number.isFinite(input.perPage) ? Math.min(200, Math.max(1, Math.trunc(input.perPage ?? 100))) : 100;
  return { page, perPage, offset: (page - 1) * perPage };
};

const normalizeValues = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);

const deliveryWhere = (filter: DeliveryFilter): SQL.Query<unknown> => {
  const conditions: SQL.Query<unknown>[] = [sql`TRUE`];
  const statuses = normalizeValues(filter.statuses).filter((status): status is NotificationDeliveryStatus =>
    DELIVERY_STATUSES.has(status as NotificationDeliveryStatus),
  );
  const channels = normalizeValues(filter.channels);
  const appIds = normalizeValues(filter.appIds);
  const search = filter.search?.trim().slice(0, 200);

  if (statuses.length > 0) conditions.push(sql`d.status = ANY(${toPgTextArray(statuses)}::text[])`);
  if (channels.length > 0) conditions.push(sql`d.channel = ANY(${toPgTextArray(channels)}::text[])`);
  if (appIds.length > 0) conditions.push(sql`n.app_id = ANY(${toPgTextArray(appIds)}::text[])`);
  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    conditions.push(sql`(
      e.title ILIKE ${pattern} ESCAPE '\\'
      OR n.label ILIKE ${pattern} ESCAPE '\\'
      OR n.kind ILIKE ${pattern} ESCAPE '\\'
      OR n.app_id ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(u.display_name, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(u.uid, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(u.mail, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(e.recipient_email, '') ILIKE ${pattern} ESCAPE '\\'
      OR d.destination_label ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(d.error_code, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(d.error_message, '') ILIKE ${pattern} ESCAPE '\\'
    )`);
  }

  return conditions.reduce((result, condition) => sql`${result} AND ${condition}`);
};

const listDeliveries = async (input: {
  page?: number;
  perPage?: number;
  filter?: DeliveryFilter;
}): Promise<PageResult<NotificationDeliveryObservabilityItem>> => {
  const { page, perPage, offset } = normalizePage(input);
  const where = deliveryWhere(input.filter ?? {});
  const [countRows, rows] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      JOIN notifications.definitions n ON n.id = e.definition_id
      LEFT JOIN auth.users u ON u.id = e.recipient_user_id
      WHERE ${where}
    `,
    sql<DeliveryRow[]>`
      SELECT
        d.id, d.event_id, e.definition_id, n.app_id, n.kind, n.label,
        e.title, e.target_href,
        COALESCE(NULLIF(u.display_name, ''), NULLIF(u.uid, ''), e.recipient_email, e.recipient_key) AS recipient_label,
        COALESCE(NULLIF(u.mail, ''), NULLIF(u.uid, ''), e.recipient_email, e.recipient_key) AS recipient_reference,
        d.channel, d.destination_label, d.required, d.route_priority, d.status,
        d.outgoing_mail_id, mail.status AS outgoing_mail_status, d.attempt_count, d.error_code, d.error_message, d.created_at, d.updated_at, d.delivered_at
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      JOIN notifications.definitions n ON n.id = e.definition_id
      LEFT JOIN auth.users u ON u.id = e.recipient_user_id
      LEFT JOIN outgoing_mail.messages mail ON mail.id = d.outgoing_mail_id
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${perPage} OFFSET ${offset}
    `,
  ]);
  const total = countRows[0]?.count ?? 0;
  return {
    items: rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      definitionId: row.definition_id,
      appId: row.app_id,
      kind: row.kind,
      label: row.label,
      title: row.title,
      targetHref: row.target_href,
      recipientLabel: row.recipient_label,
      recipientReference: row.recipient_reference,
      channel: row.channel,
      destinationLabel: row.destination_label,
      required: row.required,
      routePriority: row.route_priority,
      status: row.status,
      outgoingMailId: row.outgoing_mail_id,
      outgoingMailStatus: row.outgoing_mail_status,
      attemptCount: row.attempt_count,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
    })),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

const deliverySummary = async (
  input: { days?: number; filter?: DeliveryFilter } = {},
): Promise<{
  total: number;
  active: number;
  delivered: number;
  suppressed: number;
  failed: number;
}> => {
  const days = Number.isFinite(input.days) ? Math.min(3_650, Math.max(1, Math.trunc(input.days ?? 7))) : 7;
  const where = deliveryWhere(input.filter ?? {});
  const rows = await sql<Array<{ total: number; active: number; delivered: number; suppressed: number; failed: number }>>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE d.status IN ('deferred', 'pending', 'sending'))::int AS active,
      COUNT(*) FILTER (WHERE d.status = 'delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE d.status = 'suppressed')::int AS suppressed,
      COUNT(*) FILTER (WHERE d.status = 'failed')::int AS failed
    FROM notifications.deliveries d
    JOIN notifications.events e ON e.id = d.event_id
    JOIN notifications.definitions n ON n.id = e.definition_id
    LEFT JOIN auth.users u ON u.id = e.recipient_user_id
    WHERE ${where}
      AND d.created_at >= now() - (${days}::int * INTERVAL '1 day')
  `;
  return rows[0] ?? { total: 0, active: 0, delivered: 0, suppressed: 0, failed: 0 };
};

const deliveryTimeseries = async (
  input: { days?: number; filter?: DeliveryFilter } = {},
): Promise<NotificationDeliveryTimeseriesPoint[]> => {
  const days = Number.isFinite(input.days) ? Math.min(90, Math.max(1, Math.trunc(input.days ?? 7))) : 7;
  const bucketHours = days <= 2 ? 1 : days <= 14 ? 6 : 24;
  const where = deliveryWhere(input.filter ?? {});

  return sql<NotificationDeliveryTimeseriesPoint[]>`
    WITH bounds AS (
      SELECT
        now() AS end_at,
        now() - (${days}::int * INTERVAL '1 day') AS start_at,
        ${bucketHours}::int * INTERVAL '1 hour' AS bucket
    ),
    buckets AS (
      SELECT generate_series(
        date_bin(bucket, start_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(bucket, end_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        bucket
      ) AS at
      FROM bounds
    ),
    counts AS (
      SELECT
        date_bin(bounds.bucket, d.created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS at,
        d.status,
        COUNT(*)::int AS count
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      JOIN notifications.definitions n ON n.id = e.definition_id
      LEFT JOIN auth.users u ON u.id = e.recipient_user_id
      CROSS JOIN bounds
      WHERE ${where}
        AND d.created_at >= bounds.start_at
        AND d.created_at <= bounds.end_at
      GROUP BY at, d.status
    )
    SELECT
      buckets.at,
      COALESCE(SUM(counts.count), 0)::int AS total,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.status IN ('deferred', 'pending', 'sending')), 0)::int AS active,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.status = 'delivered'), 0)::int AS delivered,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.status = 'suppressed'), 0)::int AS suppressed,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.status = 'failed'), 0)::int AS failed
    FROM buckets
    LEFT JOIN counts USING (at)
    GROUP BY buckets.at
    ORDER BY buckets.at
  `;
};

const facets = async (): Promise<{ channels: string[]; appIds: string[] }> => {
  const [channelRows, appRows] = await Promise.all([
    sql<{ value: string }[]>`
      SELECT DISTINCT value
      FROM (
        SELECT channel AS value FROM notifications.deliveries
        UNION ALL
        SELECT unnest(recommended_channels) AS value FROM notifications.definitions
        UNION ALL
        SELECT unnest(required_channels) AS value FROM notifications.definitions
      ) channels
      WHERE btrim(value) <> ''
      ORDER BY value
    `,
    sql<{ value: string }[]>`
      SELECT DISTINCT app_id AS value
      FROM notifications.definitions
      WHERE btrim(app_id) <> ''
      ORDER BY app_id
    `,
  ]);
  return { channels: channelRows.map((row) => row.value), appIds: appRows.map((row) => row.value) };
};

const registryWhere = (filter: { search?: string; appIds?: readonly string[]; active?: boolean }): SQL.Query<unknown> => {
  const conditions: SQL.Query<unknown>[] = [sql`TRUE`];
  const appIds = normalizeValues(filter.appIds);
  const search = filter.search?.trim().slice(0, 200);
  if (appIds.length > 0) conditions.push(sql`n.app_id = ANY(${toPgTextArray(appIds)}::text[])`);
  if (filter.active !== undefined) conditions.push(sql`n.active = ${filter.active}`);
  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    conditions.push(sql`(
      n.id ILIKE ${pattern} ESCAPE '\\'
      OR n.app_id ILIKE ${pattern} ESCAPE '\\'
      OR n.kind ILIKE ${pattern} ESCAPE '\\'
      OR n.label ILIKE ${pattern} ESCAPE '\\'
      OR n.description ILIKE ${pattern} ESCAPE '\\'
    )`);
  }
  return conditions.reduce((result, condition) => sql`${result} AND ${condition}`);
};

const listDefinitions = async (input: {
  page?: number;
  perPage?: number;
  filter?: { search?: string; appIds?: readonly string[]; active?: boolean };
}): Promise<PageResult<NotificationDefinitionObservabilityItem>> => {
  const { page, perPage, offset } = normalizePage(input);
  const where = registryWhere(input.filter ?? {});
  const [countRows, rows] = await Promise.all([
    sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM notifications.definitions n WHERE ${where}`,
    sql<DefinitionRow[]>`
      SELECT
        n.id, n.app_id, n.kind, n.label, n.description, n.recipient_kind,
        n.recommended_channels, n.required_channels, n.active,
        n.first_seen_at, n.last_seen_at, n.updated_at,
        COALESCE(stats.event_count_7d, 0)::int AS event_count_7d,
        COALESCE(stats.failed_delivery_count_7d, 0)::int AS failed_delivery_count_7d
      FROM notifications.definitions n
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT e.id)::int AS event_count_7d,
          COUNT(d.id) FILTER (WHERE d.status = 'failed')::int AS failed_delivery_count_7d
        FROM notifications.events e
        LEFT JOIN notifications.deliveries d ON d.event_id = e.id
        WHERE e.definition_id = n.id
          AND e.created_at >= now() - INTERVAL '7 days'
      ) stats ON TRUE
      WHERE ${where}
      ORDER BY n.app_id, n.label, n.id
      LIMIT ${perPage} OFFSET ${offset}
    `,
  ]);
  const total = countRows[0]?.count ?? 0;
  return {
    items: rows.map((row) => ({
      id: row.id,
      appId: row.app_id,
      kind: row.kind,
      label: row.label,
      description: row.description,
      recipientKind: row.recipient_kind,
      recommendedChannels: row.recommended_channels,
      requiredChannels: row.required_channels,
      active: row.active,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      updatedAt: row.updated_at,
      eventCount7d: row.event_count_7d,
      failedDeliveryCount7d: row.failed_delivery_count_7d,
    })),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

const registrySummary = async (): Promise<{ total: number; active: number; apps: number; required: number }> => {
  const rows = await sql<Array<{ total: number; active: number; apps: number; required: number }>>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE active)::int AS active,
      COUNT(DISTINCT app_id)::int AS apps,
      COUNT(*) FILTER (WHERE cardinality(required_channels) > 0)::int AS required
    FROM notifications.definitions
  `;
  return rows[0] ?? { total: 0, active: 0, apps: 0, required: 0 };
};

export const notificationObservability = {
  deliveries: { list: listDeliveries, summary: deliverySummary, timeseries: deliveryTimeseries },
  registry: { list: listDefinitions, summary: registrySummary },
  facets,
} as const;
