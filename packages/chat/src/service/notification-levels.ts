import type { SQLQuery, sql } from "bun";

export type NotificationChoice = "default" | "all" | "mentions" | "none";
export type NotificationContext = {
  kind: "chat" | "system";
  channel: boolean;
  permission: "read" | "write" | "admin";
  memberCount: number;
};

/** Resolve at the caller's snapshot time; expiry resets the choice, not just its displayed level. */
export const resolveNotifications = (
  context: NotificationContext & { notify: NotificationChoice; notifyUntil: Date | null },
  now: Date,
) => {
  if (context.notifyUntil !== null && context.notify !== "none") throw new Error("notify_until requires notify=none");
  const defaultLevel: "all" | "mentions" =
    context.kind === "system"
      ? "mentions"
      : (context.channel && context.permission === "read") || context.memberCount <= 20
        ? "all"
        : "mentions";
  const stored = context.notifyUntil !== null && context.notifyUntil <= now ? "default" : context.notify;
  return {
    level: stored === "default" ? defaultLevel : stored,
    choice: stored === "default" ? null : stored,
    until: stored === "none" ? (context.notifyUntil?.toISOString() ?? null) : null,
    defaultLevel,
  };
};

/** SQL expressions are supplied by the owning query, so delivery and projections share these rules. */
export const defaultNotificationLevelSql = (
  db: typeof sql,
  context: { kind: SQLQuery; channel: SQLQuery; permission: SQLQuery; memberCount: SQLQuery },
) =>
  db`CASE WHEN ${context.kind} = 'system' THEN 'mentions'
    WHEN (${context.channel} AND ${context.permission} = 'read') OR ${context.memberCount} <= 20 THEN 'all' ELSE 'mentions' END`;
export const effectiveNotificationLevelSql = (
  db: typeof sql,
  context: Parameters<typeof defaultNotificationLevelSql>[1] & { notify: SQLQuery; notifyUntil: SQLQuery; now?: SQLQuery },
) =>
  db`CASE WHEN ${context.notify} = 'default' OR (${context.notifyUntil} IS NOT NULL AND ${context.notifyUntil} <= ${context.now ?? db`now()`})
    THEN ${defaultNotificationLevelSql(db, context)} ELSE ${context.notify} END`;
