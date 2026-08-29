import { sql } from "bun";
import {
  isSafeNotificationTargetHref,
  type NotificationDefinitionPresentationCatalog,
  resolveNotificationDefinitionPresentation,
} from "../../contracts/notification-types";
import type { MutationResult } from "../../contracts/shared";
import type {
  NotificationDeliveryStatus,
  UserNotificationHistoryResponse,
  UserNotificationPreference,
  UserNotificationPreferencesResponse,
} from "../../contracts/user-notifications";
import { normalizeLocale } from "../../shared/locale";
import { toPgTextArray } from "../postgres";
import { listNotificationChannels } from "./channels";

type PreferenceRow = {
  id: string;
  app_id: string;
  kind: string;
  label: string;
  description: string;
  presentation: NotificationDefinitionPresentationCatalog | null;
  recommended_channels: string[];
  required_channels: string[];
  channels: string[] | null;
  customized: boolean;
};

type HistoryRow = {
  id: string;
  event_id: string;
  definition_id: string;
  app_id: string;
  label: string;
  description: string;
  presentation: NotificationDefinitionPresentationCatalog | null;
  title: string;
  target_href: string | null;
  channel: string;
  destination_label: string;
  required: boolean;
  status: NotificationDeliveryStatus;
  attempt_count: number;
  error_code: string | null;
  created_at: Date;
  delivered_at: Date | null;
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const definitionPresentation = (
  row: Pick<PreferenceRow, "label" | "description" | "presentation">,
  locale?: string,
): { label: string; description: string } => resolveNotificationDefinitionPresentation(row, locale);

const mapPreference = (row: PreferenceRow, locale?: string): UserNotificationPreference => {
  const requiredChannels = unique(row.required_channels);
  const required = new Set(requiredChannels);
  const selectedChannels = unique(row.customized ? (row.channels ?? []) : row.recommended_channels).filter(
    (channel) => !required.has(channel),
  );
  const presentation = definitionPresentation(row, locale);
  return {
    id: row.id,
    appId: row.app_id,
    kind: row.kind,
    label: presentation.label,
    description: presentation.description,
    recommendedChannels: unique(row.recommended_channels),
    requiredChannels,
    selectedChannels,
    effectiveChannels: unique([...requiredChannels, ...selectedChannels]),
    customized: row.customized,
  };
};

const listPreferences = async (userId: string, locale?: string): Promise<UserNotificationPreferencesResponse> => {
  const rows = await sql<PreferenceRow[]>`
    SELECT d.id, d.app_id, d.kind, d.label, d.description, d.presentation,
           d.recommended_channels, d.required_channels, p.channels,
           (p.user_id IS NOT NULL) AS customized
    FROM notifications.definitions d
    LEFT JOIN notifications.preferences p
      ON p.definition_id = d.id AND p.user_id = ${userId}::uuid
    WHERE d.active = true AND d.recipient_kind = 'user'
    ORDER BY d.app_id, d.id
  `;
  const definitions = rows
    .map((row) => mapPreference(row, locale))
    .sort(
      (left, right) =>
        left.appId.localeCompare(right.appId) ||
        left.label.localeCompare(right.label, normalizeLocale(locale)) ||
        left.id.localeCompare(right.id),
    );
  return { availableChannels: listNotificationChannels(), definitions };
};

const findPreference = async (userId: string, definitionId: string, locale?: string): Promise<UserNotificationPreference | null> => {
  const result = await listPreferences(userId, locale);
  return result.definitions.find((definition) => definition.id === definitionId) ?? null;
};

const setPreference = async (config: {
  userId: string;
  definitionId: string;
  channels: string[];
  locale?: string;
}): Promise<MutationResult<UserNotificationPreference>> => {
  const rows = await sql<{ required_channels: string[] }[]>`
    SELECT required_channels
    FROM notifications.definitions
    WHERE id = ${config.definitionId} AND active = true AND recipient_kind = 'user'
    LIMIT 1
  `;
  const definition = rows[0];
  if (!definition) return { ok: false, error: "Notification preference not found", status: 404 };

  const required = new Set(definition.required_channels);
  const channels = unique(config.channels.map((channel) => channel.trim()).filter(Boolean)).filter((channel) => !required.has(channel));
  const available = new Set(listNotificationChannels());
  const unavailable = channels.filter((channel) => !available.has(channel));
  if (unavailable.length > 0) {
    return { ok: false, error: `Unavailable notification channel: ${unavailable.join(", ")}`, status: 400 };
  }

  await sql`
    INSERT INTO notifications.preferences (user_id, definition_id, channels, updated_at)
    VALUES (${config.userId}::uuid, ${config.definitionId}, ${toPgTextArray(channels)}::text[], now())
    ON CONFLICT (user_id, definition_id) DO UPDATE
    SET channels = EXCLUDED.channels, updated_at = now()
  `;
  const preference = await findPreference(config.userId, config.definitionId, config.locale);
  if (!preference) return { ok: false, error: "Notification preference not found", status: 404 };
  return { ok: true, data: preference };
};

const resetPreference = async (config: {
  userId: string;
  definitionId: string;
  locale?: string;
}): Promise<MutationResult<UserNotificationPreference>> => {
  const existing = await findPreference(config.userId, config.definitionId, config.locale);
  if (!existing) return { ok: false, error: "Notification preference not found", status: 404 };
  await sql`
    DELETE FROM notifications.preferences
    WHERE user_id = ${config.userId}::uuid AND definition_id = ${config.definitionId}
  `;
  const preference = await findPreference(config.userId, config.definitionId, config.locale);
  if (!preference) return { ok: false, error: "Notification preference not found", status: 404 };
  return { ok: true, data: preference };
};

const publicDeliveryError = (code: string | null, status: NotificationDeliveryStatus): { code: string | null; message: string | null } => {
  if (!code) return { code: null, message: null };
  switch (code) {
    case "disabled_by_user":
      return { code, message: "Delivery is disabled in your notification preferences." };
    case "no_preferred_channel":
      return { code, message: "No preferred delivery channel is configured." };
    case "channel_unavailable":
      return { code, message: "This delivery channel is currently unavailable." };
    case "no_endpoint":
      return { code, message: "No registered destination is available for this channel." };
    case "fallback_not_needed":
      return { code, message: "Another preferred channel delivered this notification." };
    case "lease_recovered":
      return { code, message: "Delivery resumed after an interrupted attempt." };
    default:
      return {
        code: "provider_error",
        message:
          status === "pending" || status === "sending"
            ? "The provider reported an error; delivery will retry."
            : "The provider could not deliver this notification.",
      };
  }
};

const listHistory = async (config: {
  userId: string;
  page: number;
  perPage: number;
  status?: NotificationDeliveryStatus;
  locale?: string;
}): Promise<UserNotificationHistoryResponse> => {
  const page = Math.max(1, config.page);
  const perPage = Math.min(100, Math.max(1, config.perPage));
  const offset = (page - 1) * perPage;
  const status = config.status ?? null;
  const [countRows, rows] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      WHERE e.recipient_user_id = ${config.userId}::uuid
        AND (${status}::text IS NULL OR d.status = ${status})
    `,
    sql<HistoryRow[]>`
      SELECT d.id, d.event_id, e.definition_id, n.app_id, n.label, n.description, n.presentation, e.title, e.target_href,
             d.channel, d.destination_label, d.required, d.status, d.attempt_count,
             d.error_code, d.created_at, d.delivered_at
      FROM notifications.deliveries d
      JOIN notifications.events e ON e.id = d.event_id
      JOIN notifications.definitions n ON n.id = e.definition_id
      WHERE e.recipient_user_id = ${config.userId}::uuid
        AND (${status}::text IS NULL OR d.status = ${status})
      ORDER BY e.created_at DESC, d.required DESC, d.route_priority NULLS FIRST, d.created_at, d.id
      LIMIT ${perPage} OFFSET ${offset}
    `,
  ]);
  const total = Number(countRows[0]?.count ?? 0);
  return {
    items: rows.map((row) => {
      const error = publicDeliveryError(row.error_code, row.status);
      const presentation = definitionPresentation(row, config.locale);
      return {
        id: row.id,
        eventId: row.event_id,
        definitionId: row.definition_id,
        appId: row.app_id,
        label: presentation.label,
        title: row.title,
        targetHref: row.target_href && isSafeNotificationTargetHref(row.target_href) ? row.target_href : null,
        channel: row.channel,
        destinationLabel: row.destination_label,
        required: row.required,
        status: row.status,
        attemptCount: row.attempt_count,
        errorCode: error.code,
        errorMessage: error.message,
        createdAt: row.created_at.toISOString(),
        deliveredAt: row.delivered_at?.toISOString() ?? null,
      };
    }),
    total,
    page,
    perPage,
    totalPages: total === 0 ? 0 : Math.ceil(total / perPage),
  };
};

export const userNotifications = {
  preferences: { list: listPreferences, set: setPreference, reset: resetPreference },
  history: { list: listHistory },
} as const;
