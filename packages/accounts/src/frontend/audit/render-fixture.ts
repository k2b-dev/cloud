/** Invented audit events for the audit log's render and browser tests; fixed dates, so nothing depends on today. */
import type { AuditEvent } from "@k2b/cloud/services";

export const ACTOR_ID = "55555555-5555-4555-8555-000000000001";
export const TARGET_USER_ID = "55555555-5555-4555-8555-000000000002";
export const TARGET_GROUP_ID = "55555555-5555-4555-8555-000000000003";
export const SERVICE_ACCOUNT_ID = "55555555-5555-4555-8555-000000000004";

const base = (id: number, patch: Partial<AuditEvent>): AuditEvent => ({
  id,
  createdAt: `2026-11-20T${String(8 + (id % 10)).padStart(2, "0")}:${String((id * 7) % 60).padStart(2, "0")}:00.000Z`,
  action: "accounts.user.update",
  outcome: "allowed",
  actor: { userId: ACTOR_ID, uid: "ada.renz", provider: "local", roles: ["user", "admin"] },
  target: { type: "user", id: TARGET_USER_ID, label: "milan.horvat", provider: "local" },
  reason: null,
  errorCode: null,
  errorMessage: null,
  requestId: null,
  metadata: {},
  ...patch,
});

export const AUDIT_EVENTS: AuditEvent[] = [
  base(12, { action: "accounts.user.create", target: { type: "user", id: TARGET_USER_ID, label: "milan.horvat", provider: "local" } }),
  base(11, {
    action: "accounts.group.member.add",
    target: { type: "group", id: TARGET_GROUP_ID, label: "verkauf", provider: "local" },
  }),
  base(10, { action: "accounts.user.password_reset", outcome: "denied", reason: "Nur Administratoren dürfen Passwörter zurücksetzen." }),
  base(9, {
    action: "service_account_credential.create",
    actor: { userId: null, uid: null, provider: null, roles: [] },
    target: { type: "service_account", id: SERVICE_ACCOUNT_ID, label: "Backup-Agent", provider: null },
    metadata: { serviceAccountId: SERVICE_ACCOUNT_ID },
  }),
  base(8, {
    action: "accounts.user.send_login_link",
    outcome: "failed",
    errorMessage: "SMTP: connection refused",
    actor: { userId: ACTOR_ID, uid: null, provider: "ipa", roles: ["user"] },
  }),
  base(7, { action: "ai.approval.remember", target: { type: "ai_approval", id: "approval-7", label: null, provider: null } }),
  base(6, { action: "external.provider.sync", target: { type: null, id: null, label: null, provider: null } }),
];

// A working day of an administration: real people, real deeds, a few refused or failed.
const PEOPLE = [
  ["55555555-5555-4555-8555-000000000011", "ada.renz"],
  ["55555555-5555-4555-8555-000000000012", "felix.thal"],
  ["55555555-5555-4555-8555-000000000013", "lena.hartwig"],
  ["55555555-5555-4555-8555-000000000014", "sami.yilmaz"],
] as const;
const DEEDS: [string, "user" | "group" | "service_account" | "ai_approval", string, "allowed" | "denied" | "failed", string | null][] = [
  ["accounts.user.create", "user", "jonas.kern", "allowed", null],
  ["accounts.group.member.add", "group", "werkstatt", "allowed", null],
  ["accounts.user.password_reset", "user", "mira.solberg", "denied", "Nur Administratoren dürfen Passwörter zurücksetzen."],
  ["service_account_credential.create", "service_account", "Backup-Agent", "allowed", null],
  ["accounts.user.send_login_link", "user", "tom.oswald", "failed", "SMTP: connection refused"],
  ["accounts.group.manager.add", "group", "lager-nord", "allowed", null],
  ["ai.approval.remember", "ai_approval", "Rechnungen buchen", "allowed", null],
  ["accounts.user.set_expiry", "user", "jana.berger", "allowed", null],
  ["accounts.group.member.remove", "group", "personal", "allowed", null],
  ["service_account_credential.revoke", "service_account", "Rechnungs-Import", "allowed", null],
  ["accounts.user.update", "user", "lena.hartwig", "allowed", null],
  ["accounts.request.deny", "user", "k.wagner@gmail.example", "allowed", "Kein Vertrag mit der Werkstatt."],
];
/** A dense log: `length` events, one every 47 minutes back from `now`, by four people and the system. */
export const denseAuditEvents = (now: Date, length = 28): AuditEvent[] =>
  Array.from({ length }, (_, index) => {
    const [action, type, label, outcome, reason] = DEEDS[index % DEEDS.length]!;
    const [userId, uid] = PEOPLE[index % PEOPLE.length]!;
    return {
      ...AUDIT_EVENTS[0]!,
      id: 500 - index,
      createdAt: new Date(now.getTime() - index * 47 * 60 * 1000).toISOString(),
      action,
      outcome,
      actor:
        index % 9 === 4
          ? { userId: null, uid: null, provider: null, roles: [] }
          : { userId, uid, provider: index % 3 ? "local" : "ipa", roles: ["user"] },
      target: { type, id: `55555555-5555-4555-8555-${String(100 + index).padStart(12, "0")}`, label, provider: "local" },
      reason,
    };
  });
