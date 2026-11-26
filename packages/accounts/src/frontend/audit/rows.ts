import type { AuditEvent, AuditOutcome } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import type { AccountsMessages } from "../messages";
import { actionLabel } from "./audit-labels";

/** One audit event as the list shows it, worded and dated on the server, so the first picture and the live page agree. */
export type AuditRow = {
  id: string;
  /** The day the event belongs to ("Heute", "Gestern", "18. Nov. 2026") and its time on that day. */
  day: string;
  time: string;
  actor: { label: string; userId: string | null; provider: string | null };
  action: { label: string; code: string };
  target: { label: string; kind: string; type: string | null; href: string | null };
  outcome: AuditOutcome;
  reason: string | null;
};

/** A user whose name the server looked up, because the event recorded only the user's ID. */
export type NamedUser = { userId: string; name: string };

export const auditRows = (
  events: readonly AuditEvent[],
  context: {
    t: AccountsMessages;
    locale: string;
    timeZone: string;
    names: readonly NamedUser[];
    now: Date;
    today: string;
    yesterday: string;
  },
): AuditRow[] => {
  const { t, locale, timeZone } = context;
  const nameOf = (userId: string) => context.names.find((entry) => entry.userId === userId)?.name;
  const actorLabel = (actor: AuditEvent["actor"]) => {
    if (!actor.userId) return actor.uid ?? t.system;
    const displayName = actor.uid ?? nameOf(actor.userId);
    return principalLabel({ principal: { type: "user", userId: actor.userId }, displayName }, locale);
  };
  const targetLabel = (target: AuditEvent["target"]) =>
    target.type === "user"
      ? principalLabel({ principal: { type: "user", userId: target.id ?? "" }, displayName: target.label }, locale)
      : target.type === "group"
        ? principalLabel({ principal: { type: "group", groupId: target.id ?? "" }, displayName: target.label }, locale)
        : target.type === "service_account"
          ? principalLabel({ principal: { type: "service_account", serviceAccountId: target.id ?? "" }, displayName: target.label }, locale)
          : (target.label ?? target.id ?? "–");
  const targetKind = (type: string | null) =>
    type === "user" ? t.userTarget : type === "group" ? t.groupTarget : type === "ai_approval" ? t.approvalTarget : (type ?? t.targetType);
  // the calendar day of an instant in the reader's zone, to group the events by day
  const dayKey = (instant: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  const todayKey = dayKey(context.now);
  const yesterdayKey = dayKey(new Date(context.now.getTime() - 24 * 60 * 60 * 1000));
  const dayLabel = (iso: string) => {
    const key = dayKey(new Date(iso));
    return key === todayKey ? context.today : key === yesterdayKey ? context.yesterday : dates.formatDate(iso, { locale, timeZone });
  };
  return events.map((event) => ({
    id: String(event.id),
    day: dayLabel(event.createdAt),
    time: dates.formatTime(event.createdAt, { locale, timeZone }),
    actor: {
      label: actorLabel(event.actor),
      userId: event.actor.userId,
      provider: event.actor.provider === "ipa" ? "FreeIPA" : event.actor.provider === "local" ? t.local : event.actor.provider,
    },
    action: { label: actionLabel(event.action, t), code: event.action },
    target: {
      label: targetLabel(event.target),
      kind: targetKind(event.target.type),
      type: event.target.type,
      href:
        event.target.type === "user" && event.target.id
          ? `/app/accounts/users/${event.target.id}`
          : event.target.type === "group" && event.target.id
            ? `/app/accounts/groups/${event.target.id}`
            : null,
    },
    outcome: event.outcome,
    reason: event.reason ?? event.errorMessage,
  }));
};
