import { managerEligibility } from "../_internal/app-access-manager-sql";
import { sql } from "../runtime/clients";
import type { RequestAuthority } from "../server/middleware/auth";
import { AppAccessManagementError, canReadAppAdministration } from "./app-access-management";
import type { LastRejectedStart } from "./app-keys";

export type AppAdminFacts = {
  access: { people: number; groups: number; serviceAccounts: number; managers: number; configured: boolean } | null;
  keys: {
    active: number;
    expired: number;
    revoked: number;
    lastUsedAt: string | null;
    firstCreatedAt: string | null;
    accountStatus: "active" | "disabled" | null;
  };
  tokens: { active: number; total: number };
  /** Core's last refusal of a start with a verified proof; cleared by the next successful start. */
  lastRejectedStart: Omit<LastRejectedStart, "keyId"> | null;
  events: { hears: number; sends: number | null; failedDeliveries: number; waitingDeliveries: number };
  notifications: number | null;
  firstKnownAt: string | null;
};

/** Core-owned administration summary: at most 500 input IDs and five batched SQL reads. */
export const appAdminFacts = async (authority: RequestAuthority, appIds: readonly string[]): Promise<Map<string, AppAdminFacts>> => {
  if (!canReadAppAdministration(authority)) throw new AppAccessManagementError("FORBIDDEN", "Cloud administration authority is required.");
  if (appIds.length > 500) throw new AppAccessManagementError("TOO_MANY_APPS", "At most 500 application IDs may be read at once.", 400);
  const ids = [...new Set(appIds)];
  const facts = new Map<string, AppAdminFacts>(
    ids.map((id) => [
      id,
      {
        access: null,
        keys: { active: 0, expired: 0, revoked: 0, lastUsedAt: null, firstCreatedAt: null, accountStatus: null },
        tokens: { active: 0, total: 0 },
        lastRejectedStart: null,
        events: { hears: 0, sends: 0, failedDeliveries: 0, waitingDeliveries: 0 },
        notifications: 0,
        firstKnownAt: null,
      },
    ]),
  );
  if (!ids.length) return facts;

  const [access, credentials, events, notifications, rejections] = await Promise.all([
    sql<
      {
        app_id: string;
        people: number;
        groups: number;
        service_accounts: number;
        managers: number;
        configured: boolean;
        first_known_at: Date | null;
      }[]
    >`
      SELECT COALESCE(aa.app_id, s.app_id) AS app_id,
        count(a.user_id)::int AS people, count(a.group_id)::int AS groups,
        count(a.service_account_id)::int AS service_accounts,
        count(*) FILTER (WHERE a.permission = 'admin' AND (${managerEligibility(sql)}))::int AS managers,
        s.configured_at IS NOT NULL AS configured,
        LEAST(min(a.created_at), s.configured_at) AS first_known_at
      FROM auth.app_access aa
      FULL JOIN auth.app_access_state s ON s.app_id = aa.app_id
      LEFT JOIN auth.access a ON a.id = aa.access_id
      WHERE COALESCE(aa.app_id, s.app_id) IN ${sql(ids)}
      GROUP BY aa.app_id, s.app_id, s.configured_at
    `,
    sql<
      {
        app_id: string;
        active: number;
        expired: number;
        revoked: number;
        last_used_at: Date | null;
        first_created_at: Date | null;
        account_status: "active" | "disabled";
        active_tokens: number;
        total_tokens: number;
        first_known_at: Date;
      }[]
    >`
      WITH accounts AS (
        SELECT id, app_id, status, created_at FROM auth.service_accounts
        WHERE kind = 'resource_bound' AND resource_type = 'cloud.app' AND resource_id = app_id
          AND app_id IN ${sql(ids)}
      ), canonical_accounts AS (
        SELECT DISTINCT ON (app_id) app_id, status FROM accounts ORDER BY app_id, created_at, id
      )
      SELECT sa.app_id,
        count(*) FILTER (WHERE c.kind = 'app_key' AND c.status = 'active'
          AND (c.expires_at IS NULL OR c.expires_at > now()))::int AS active,
        count(*) FILTER (WHERE c.kind = 'app_key' AND c.status <> 'revoked' AND c.expires_at <= now())::int AS expired,
        count(*) FILTER (WHERE c.kind = 'app_key' AND c.status = 'revoked')::int AS revoked,
        max(c.last_used_at) FILTER (WHERE c.kind = 'app_key') AS last_used_at,
        min(c.created_at) FILTER (WHERE c.kind = 'app_key') AS first_created_at,
        canonical.status AS account_status,
        count(*) FILTER (WHERE c.kind <> 'app_key' AND c.status = 'active'
          AND (c.expires_at IS NULL OR c.expires_at > now()))::int AS active_tokens,
        count(*) FILTER (WHERE c.kind <> 'app_key')::int AS total_tokens,
        LEAST(min(sa.created_at), min(c.created_at)) AS first_known_at
      FROM accounts sa
      JOIN canonical_accounts canonical ON canonical.app_id = sa.app_id
      LEFT JOIN auth.service_account_credentials c ON c.service_account_id = sa.id
      GROUP BY sa.app_id, canonical.status
    `,
    sql<{ app_id: string; hears: number; sends: number; failed: number; waiting: number }[]>`
      WITH subscriptions AS (
        SELECT app_id, count(*) FILTER (WHERE state = 'active')::int AS hears
        FROM events.app_subscriptions WHERE app_id IN ${sql(ids)} GROUP BY app_id
      ), declarations AS (
        SELECT app_id, count(*)::int AS sends
        FROM events.app_declarations WHERE app_id IN ${sql(ids)} AND retired_at IS NULL GROUP BY app_id
      ), deliveries AS (
        SELECT subscription.app_id, count(*) FILTER (WHERE delivery.state = 'failed')::int AS failed,
          count(*) FILTER (WHERE delivery.state IN ('pending', 'retrying'))::int AS waiting
        FROM events.app_subscriptions subscription
        JOIN events.app_deliveries delivery ON delivery.subscription_id = subscription.id
        WHERE subscription.app_id IN ${sql(ids)} AND delivery.state IN ('failed', 'pending', 'retrying')
        GROUP BY subscription.app_id
      )
      SELECT COALESCE(s.app_id, d.app_id, f.app_id) AS app_id, COALESCE(s.hears, 0) AS hears,
        COALESCE(d.sends, 0) AS sends, COALESCE(f.failed, 0) AS failed, COALESCE(f.waiting, 0) AS waiting
      FROM subscriptions s FULL JOIN declarations d ON d.app_id = s.app_id
      FULL JOIN deliveries f ON f.app_id = COALESCE(s.app_id, d.app_id)
    `,
    sql<{ app_id: string; count: number }[]>`
      SELECT app_id, count(*)::int AS count FROM notifications.definitions
      WHERE app_id IN ${sql(ids)} AND active = true GROUP BY app_id
    `,
    sql<{ app_id: string; rejected_at: Date; reason: LastRejectedStart["reason"] }[]>`
      SELECT app_id, rejected_at, reason FROM auth.app_start_rejections WHERE app_id IN ${sql(ids)}
    `,
  ]);

  for (const row of access) {
    const fact = facts.get(row.app_id)!;
    fact.access = {
      people: row.people,
      groups: row.groups,
      serviceAccounts: row.service_accounts,
      managers: row.managers,
      configured: row.configured,
    };
    fact.firstKnownAt = row.first_known_at?.toISOString() ?? null;
  }
  for (const row of credentials) {
    const fact = facts.get(row.app_id)!;
    fact.keys = {
      active: row.active,
      expired: row.expired,
      revoked: row.revoked,
      lastUsedAt: row.last_used_at?.toISOString() ?? null,
      firstCreatedAt: row.first_created_at?.toISOString() ?? null,
      accountStatus: row.account_status,
    };
    fact.tokens = { active: row.active_tokens, total: row.total_tokens };
    const firstKnownAt = row.first_known_at.toISOString();
    if (fact.firstKnownAt === null || firstKnownAt < fact.firstKnownAt) fact.firstKnownAt = firstKnownAt;
  }
  for (const row of events) {
    facts.get(row.app_id)!.events = { hears: row.hears, sends: row.sends, failedDeliveries: row.failed, waitingDeliveries: row.waiting };
  }
  for (const row of notifications) facts.get(row.app_id)!.notifications = row.count;
  for (const row of rejections) facts.get(row.app_id)!.lastRejectedStart = { at: row.rejected_at.toISOString(), reason: row.reason };
  return facts;
};
