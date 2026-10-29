import { type SQL, sql } from "bun";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { getApp, listApps, listCapabilities } from "../_internal/registry";
import {
  APP_DETAILS_FAILED_LIMIT,
  APP_DETAILS_LIST_LIMIT,
  APP_SUBSCRIPTION_NEW_WINDOW_MS,
  type AppDetails,
} from "../contracts/app-details";
import { type NotificationDefinitionPresentationCatalog, resolveNotificationDefinitionPresentation } from "../contracts/notification-types";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server/middleware/auth";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { AppAccessManagementError, appAccessGrantCounts, canRepairAppAccess } from "./app-access-management";
import type { StoredDeclaration } from "./app-events/declarations";

type SubscriptionRow = {
  id: string;
  event_type: string;
  version: number;
  state: AppDetails["hears"][number]["state"];
  reason: string | null;
  first_seen_at: Date;
  is_new: boolean;
  publisher_app_id: string | null;
  title: string | null;
  total: number;
};
type NotificationRow = {
  id: string;
  kind: string;
  label: string;
  description: string;
  presentation: NotificationDefinitionPresentationCatalog | null;
  recipient_kind: "user" | "email";
  required_channels: string[];
  recommended_channels: string[];
  excluded_channels: string[];
  excluded_reason: string | null;
  total: number;
};
type Dependencies = {
  db?: SQL;
  getApp?: (appId: string) => Promise<AppRegistryEntry | null>;
  apps?: () => Promise<AppRegistryEntry[]>;
  capabilities?: () => Promise<CapabilityRegistryEntry[]>;
  grantCounts?: typeof appAccessGrantCounts;
};

/** Core-owned administration read shared by SSR and HTTP; app access is not administrator authority. */
export function createAppDetailsService(dependencies: Dependencies = {}) {
  const db = dependencies.db ?? sql;
  return async (appId: string, options: { authority: RequestAuthority; locale?: string }): Promise<AppDetails | null> => {
    if (!canRepairAppAccess(options.authority))
      throw new AppAccessManagementError("FORBIDDEN", "Cloud administration authority is required.");
    const locale = options.locale ?? "en";
    const [app, known] = await Promise.all([
      (dependencies.getApp ?? getApp)(appId),
      db<{ known: boolean }[]>`
        SELECT EXISTS (
          SELECT FROM events.app_manifests WHERE app_id = ${appId}
          UNION ALL SELECT FROM events.app_declarations WHERE app_id = ${appId}
          UNION ALL SELECT FROM events.app_subscriptions WHERE app_id = ${appId}
          UNION ALL SELECT FROM notifications.definitions WHERE app_id = ${appId}
          UNION ALL SELECT FROM auth.app_access_state WHERE app_id = ${appId}
          UNION ALL SELECT FROM auth.app_access WHERE app_id = ${appId}
        ) AS known
      `,
    ]);
    if (!app && !known[0]?.known) return null;

    const [capabilities, declarations, subscriptions, definitions, grantCounts] = await Promise.all([
      (dependencies.capabilities ?? listCapabilities)(),
      db<(StoredDeclaration & { subscriber_count: number; total: number })[]>`
        SELECT declaration.*, count(*) OVER()::int AS total,
          (SELECT count(*)::int FROM events.app_subscriptions subscription
            WHERE subscription.event_type = declaration.type AND subscription.version = declaration.version
              AND subscription.state <> 'cancelled') AS subscriber_count
        FROM events.app_declarations declaration
        WHERE declaration.app_id = ${appId} AND declaration.retired_at IS NULL
        ORDER BY declaration.type, declaration.version
        LIMIT ${APP_DETAILS_LIST_LIMIT}
      `,
      db<SubscriptionRow[]>`
        SELECT subscription.id, subscription.event_type, subscription.version, subscription.state,
          subscription.reason, subscription.first_seen_at, declaration.app_id AS publisher_app_id,
          subscription.first_seen_at >= now() - ${APP_SUBSCRIPTION_NEW_WINDOW_MS} * interval '1 millisecond' AS is_new,
          declaration.title, count(*) OVER()::int AS total
        FROM events.app_subscriptions subscription
        LEFT JOIN events.app_declarations declaration
          ON declaration.type = subscription.event_type AND declaration.version = subscription.version
        WHERE subscription.app_id = ${appId}
        ORDER BY subscription.first_seen_at DESC, subscription.id
        LIMIT ${APP_DETAILS_LIST_LIMIT}
      `,
      db<NotificationRow[]>`
        SELECT id, kind, label, description, presentation, recipient_kind,
          required_channels, recommended_channels, excluded_channels, excluded_reason, count(*) OVER()::int AS total
        FROM notifications.definitions
        WHERE app_id = ${appId} AND active = true
        ORDER BY id
        LIMIT ${APP_DETAILS_LIST_LIMIT}
      `,
      app?.access?.kind === "grants"
        ? (dependencies.grantCounts ?? appAccessGrantCounts)(options.authority, [app])
        : Promise.resolve(new Map<string, number>()),
    ]);
    const declaredCallers =
      capabilities
        .find((entry) => entry.appId === appId)
        ?.manifest.queries.flatMap((query) =>
          [...new Set(query.callers ?? [])].map((callerAppId) => ({ queryId: query.localId, callerAppId })),
        ) ?? [];
    // Live presence, not the built-in inventory or persisted app history, controls caller admission.
    const registeredIds = new Set(declaredCallers.length ? (await (dependencies.apps ?? listApps)()).map((entry) => entry.id) : []);
    const unregisteredQueryCallers = declaredCallers
      .filter(({ callerAppId }) => !registeredIds.has(callerAppId))
      .sort((a, b) => a.queryId.localeCompare(b.queryId) || a.callerAppId.localeCompare(b.callerAppId));
    const presentations = new Map<string, { title: string; description: string }>(
      capabilities.flatMap((entry) =>
        (resolveCapabilityManifestPresentation(entry.manifest, entry.presentation, locale).events ?? []).map(
          (event) => [`${entry.appId}.${event.localId}@${event.version}`, event] as const,
        ),
      ),
    );
    const subscriptionIds = subscriptions.map((subscription) => subscription.id);
    const [deliveryCounts, failedDeliveries] = subscriptionIds.length
      ? await Promise.all([
          db<{ subscription_id: string; state: keyof AppDetails["hears"][number]["counts"]; count: number }[]>`
            SELECT subscription_id, state, count(*)::int AS count
            FROM events.app_deliveries
            WHERE subscription_id IN ${db(subscriptionIds)}
            GROUP BY subscription_id, state
          `,
          db<
            {
              subscription_id: string;
              id: string;
              eventId: string;
              code: string | null;
              lastError: string | null;
              attempts: number;
              lastAttemptAt: Date | null;
            }[]
          >`
            SELECT subscription.id AS subscription_id, failed.*
            FROM events.app_subscriptions subscription
            CROSS JOIN LATERAL (
              SELECT id, event_id AS "eventId", code, left(last_error, 1000) AS "lastError",
                attempts, last_attempt_at AS "lastAttemptAt"
              FROM events.app_deliveries
              WHERE subscription_id = subscription.id AND state = 'failed'
              ORDER BY last_attempt_at DESC NULLS LAST, seq DESC
              LIMIT ${APP_DETAILS_FAILED_LIMIT}
            ) failed
            WHERE subscription.id IN ${db(subscriptionIds)}
            ORDER BY subscription.id, failed."lastAttemptAt" DESC NULLS LAST, failed.id
          `,
        ])
      : [[], []];
    const hears = subscriptions.map((subscription): AppDetails["hears"][number] => {
      const counts: AppDetails["hears"][number]["counts"] = { pending: 0, retrying: 0, done: 0, failed: 0, cancelled: 0 };
      for (const row of deliveryCounts) if (row.subscription_id === subscription.id) counts[row.state] = row.count;
      return {
        subscriptionId: subscription.id,
        eventType: subscription.event_type,
        version: subscription.version,
        publisherAppId: subscription.publisher_app_id ?? subscription.event_type.split(".")[0] ?? subscription.event_type,
        title: presentations.get(`${subscription.event_type}@${subscription.version}`)?.title ?? subscription.title,
        state: subscription.state,
        reason: subscription.reason,
        firstSeenAt: subscription.first_seen_at.toISOString(),
        isNew: subscription.is_new,
        counts,
        failedDeliveries: failedDeliveries
          .filter((row) => row.subscription_id === subscription.id)
          .map(({ subscription_id: _subscriptionId, lastAttemptAt, ...row }) => ({
            ...row,
            lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
          })),
      };
    });
    return {
      app: {
        id: appId,
        ...(app ? resolveAppIdentityPresentation(app, locale) : { name: appId, description: null }),
        icon: app?.icon ?? null,
        accent: app?.appearance?.accent ?? null,
        online: app !== null,
      },
      access: {
        kind: app ? (app.access?.kind ?? "legacy") : null,
        roles: app?.access?.kind === "roles" ? [...app.access.roles] : [],
        grantCount: app?.access?.kind === "grants" ? (grantCounts.get(appId) ?? 0) : null,
        platformPermissions: [...(app?.platformPermissions ?? [])],
      },
      unregisteredQueryCallers: unregisteredQueryCallers.slice(0, APP_DETAILS_LIST_LIMIT),
      sends: declarations.map((declaration) => {
        const presentation = presentations.get(`${declaration.type}@${declaration.version}`);
        return {
          type: declaration.type,
          version: declaration.version,
          title: presentation?.title ?? declaration.title,
          description: presentation?.description ?? declaration.description,
          subject: `${declaration.app_id}.${declaration.subject}`,
          place: declaration.place ? `${declaration.app_id}.${declaration.place}` : null,
          automation: declaration.automation,
          subscriberCount: declaration.subscriber_count,
        };
      }),
      hears,
      notifications: definitions.map((definition) => {
        const presentation = resolveNotificationDefinitionPresentation(
          { ...definition, excludedReason: definition.excluded_reason ?? undefined },
          locale,
        );
        return {
          id: definition.id,
          kind: definition.kind,
          ...presentation,
          recipientKind: definition.recipient_kind,
          requiredChannels: definition.required_channels,
          recommendedChannels: definition.recommended_channels,
          excludedChannels: definition.excluded_channels,
          excludedReason: presentation.excludedReason ?? null,
        };
      }),
      totals: {
        sends: declarations[0]?.total ?? 0,
        hears: subscriptions[0]?.total ?? 0,
        notifications: definitions[0]?.total ?? 0,
        unregisteredQueryCallers: unregisteredQueryCallers.length,
      },
    };
  };
}

export const appDetails = createAppDetailsService();
