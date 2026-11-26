/**
 * Invented notification batches and recipients for the SSR render tests of the notification pages, plus the Hono app
 * those tests mount a page on as an administrator. The dates are fixed, so the rendered HTML never depends on today.
 */
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import type { NotificationBatch, NotificationBatchRecipient } from "@k2b/cloud/services";
import { Hono } from "hono";

export const ADMIN = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const DAY_MS = 24 * 60 * 60 * 1000;

export const BATCH_ID = "22222222-2222-4222-8222-222222222222";

const SUBJECTS = [
  "Wartungsfenster heute Nacht",
  "Neue Öffnungszeiten der Werkstatt",
  "Passkeys ab Dezember Pflicht",
  "Inventur am Samstag",
  "Umzug des Lagers nach Halle 3",
  "Jahresabschluss: Belege bis Freitag",
  "Neue Schichtpläne für Dezember",
  "Erste-Hilfe-Kurs am 4. Dezember",
  "Weihnachtsfeier: Anmeldung offen",
  "Sicherheitsunterweisung Halle 2",
  "Urlaubsplanung 2027 beginnt",
  "Neues Zeiterfassungs-Terminal",
];
const STATUSES: NotificationBatch["status"][] = ["running", "completed", "completed_with_errors", "draft", "failed", "cancelled"];

export const batch = (index: number, patch: Partial<NotificationBatch> = {}): NotificationBatch => {
  const status = STATUSES[index % STATUSES.length]!;
  return {
    id: index === 0 ? BATCH_ID : `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    subject: SUBJECTS[index % SUBJECTS.length]!,
    bodyMarkdown: "Hallo,\n\nheute Nacht ist **Cloud** von 22 bis 23 Uhr nicht erreichbar.",
    bodyHtml: "<p>Hallo,</p><p>heute Nacht ist <strong>Cloud</strong> von 22 bis 23 Uhr nicht erreichbar.</p>",
    selection: { userIds: [], groupIds: ["33333333-3333-4333-8333-000000000001"] },
    selectionHash: `hash-${index}`,
    status,
    createdBy: ADMIN.id,
    finalizedBy: status === "draft" ? null : ADMIN.id,
    createdAt: new Date(Date.UTC(2026, 10, 20, 7) - index * DAY_MS).toISOString(),
    finalizedAt: status === "draft" ? null : new Date(Date.UTC(2026, 10, 20, 7, 5) - index * DAY_MS).toISOString(),
    startedAt: null,
    completedAt: null,
    targetCount: 12,
    deliverableCount: 11,
    sentCount: status === "draft" ? 0 : 9,
    skippedCount: 1,
    errorCount: status === "completed_with_errors" || status === "failed" ? 2 : 0,
    lastError: status === "failed" ? "SMTP: connection refused" : null,
    ...patch,
  };
};

export const BATCHES = Array.from({ length: 6 }, (_, index) => batch(index));

const NAMES = [
  "Milan Horvat",
  "Ada Renz",
  "Petra Lindqvist",
  "Jonas Wehrle",
  "Mira Kaya",
  "Lea Brandner",
  "Felix Thal",
  "Sami Yilmaz",
  "Jana Berger",
  "Tom Oswald",
  "Lena Hartwig",
  "Nora Petersen",
];

export const recipient = (
  index: number,
  status: NotificationBatchRecipient["status"],
  mail: NotificationBatchRecipient["outgoingMailStatus"],
  patch: Partial<NotificationBatchRecipient> = {},
): NotificationBatchRecipient => {
  const name = NAMES[index % NAMES.length]!;
  const uid = name.toLowerCase().replace(" ", ".");
  return {
    batchId: BATCH_ID,
    userId: `33333333-3333-4333-8333-${String(100 + index).padStart(12, "0")}`,
    recipient: `${uid}@solberg-kramer.example`,
    uid,
    displayName: name,
    avatarHash: null,
    provider: index % 3 === 2 ? "ipa" : "local",
    profile: "user",
    status,
    notificationId: null,
    outgoingMailId: mail ? `44444444-4444-4444-8444-${String(index).padStart(12, "0")}` : null,
    outgoingMailStatus: mail,
    error: status === "error" ? "550 5.1.1 mailbox unavailable" : null,
    attemptCount: status === "error" ? 3 : 1,
    sentAt: status === "sent" ? "2026-11-20T07:10:00.000Z" : null,
    updatedAt: "2026-11-20T07:10:00.000Z",
    ...patch,
  };
};

export const RECIPIENTS = [
  recipient(0, "sent", "bounced"),
  recipient(1, "sending", "queued"),
  recipient(2, "sent", "sent"),
  recipient(3, "error", "failed"),
  recipient(4, "pending", null),
  recipient(5, "skipped", null, { recipient: null }),
];

/** A Hono app that serves one Accounts page to the administrator above. */
export const adminApp = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: ADMIN });
    c.set("user", ADMIN);
    c.set("runtime", { apps: [] });
    await next();
  });
  return app;
};

/** What a page weighs in its SSR HTML: its elements and the loading indicators on the first picture (must be 0). */
export const pageWeight = (html: string) => {
  const body = html.slice(html.indexOf("<body"));
  return {
    elements: body.match(/<[a-zA-Z][\w-]*/g)?.length ?? 0,
    loaders: (body.match(/data-k2-part="Loading"|aria-busy="true"|animate-spin/g) ?? []).length,
  };
};
