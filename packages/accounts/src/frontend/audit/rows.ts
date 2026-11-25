import type { AuditEvent, AuditOutcome } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import type { AccountsMessages } from "../messages";
import { actionLabel } from "./audit-labels";

/** One audit event as the list shows it, worded and dated on the server, so the first picture and the live page agree. */
export type AuditRow = {
  id: string;
  time: string;
  actor: { label: string; userId: string | null; provider: string | null };
  action: { label: string; code: string };
  target: { label: string; kind: string; href: string | null };
  outcome: AuditOutcome;
  reason: string | null;
};

/** A user whose name the server looked up, because the event recorded only the user's ID. */
export type NamedUser = { userId: string; name: string };

export const auditRows = (
  events: readonly AuditEvent[],
  context: { t: AccountsMessages; locale: string; timeZone: string; names: readonly NamedUser[] },
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
  return events.map((event) => ({
    id: String(event.id),
    time: dates.formatDateTime(event.createdAt, { locale, timeZone }),
    actor: {
      label: actorLabel(event.actor),
      userId: event.actor.userId,
      provider: event.actor.provider === "ipa" ? "FreeIPA" : event.actor.provider === "local" ? t.local : event.actor.provider,
    },
    action: { label: actionLabel(event.action, t), code: event.action },
    target: {
      label: targetLabel(event.target),
      kind: targetKind(event.target.type),
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
