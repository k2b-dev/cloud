/**
 * Invented reminders and deleted accounts for the activity page's render and browser tests; fixed dates. The lifecycle
 * service types every text as present, so a reminder without an error carries an empty one.
 */
import type { accountsAppService } from "@k2b/cloud/services";

type Reminder = Awaited<ReturnType<typeof accountsAppService.lifecycle.reminders.list>>["items"][number];

export const REMINDERS = [
  ["Milan Horvat", "sent", ""],
  ["Ada Renz", "error", "SMTP: connection refused"],
  ["Petra Lindqvist", "pending", ""],
  ["Jonas Wehrle", "sent", ""],
].map(
  ([name, status, error], index): Reminder => ({
    id: `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`,
    userId: `33333333-3333-4333-8333-${String(200 + index).padStart(12, "0")}`,
    uid: name!.toLowerCase().replace(" ", "."),
    mail: `${name!.toLowerCase().replace(" ", ".")}@solberg-kramer.example`,
    displayName: name!,
    avatarHash: null,
    kind: "account_expiry",
    thresholdDays: index % 2 === 0 ? 14 : 3,
    targetExpiryAt: "2026-12-01T00:00:00.000Z",
    status: status!,
    attemptCount: status === "error" ? 3 : 1,
    lastAttemptAt: "2026-11-17T06:00:00.000Z",
    sentAt: status === "sent" ? "2026-11-17T06:00:00.000Z" : null,
    lastError: error!,
    createdAt: "2026-11-17T06:00:00.000Z",
  }),
);

export const DELETED = [
  ["Jonas Wehrle", "guest_expired_deleted", "local", "guest"],
  ["Mira Kaya", "manual_delete", "ipa", "user"],
  ["Lea Brandner", "sync_out_of_scope_demoted", "ipa", "user"],
].map(([name, reason, provider, profile], index) => ({
  id: `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
  deletedUserId: `33333333-3333-4333-8333-${String(300 + index).padStart(12, "0")}`,
  uid: name!.toLowerCase().replace(" ", "."),
  mail: `${name!.toLowerCase().replace(" ", ".")}@solberg-kramer.example`,
  displayName: name!,
  previousProvider: provider!,
  previousProfile: profile!,
  reason: reason!,
  deletedAt: `2026-11-${String(10 + index).padStart(2, "0")}T09:00:00.000Z`,
  meta: { actor: "ada.renz", note: index === 1 ? "Austritt zum 31.10." : null },
}));
