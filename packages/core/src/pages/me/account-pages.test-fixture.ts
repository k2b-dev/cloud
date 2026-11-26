import type {
  AppDeviceView,
  ServiceAccountCredential,
  UserNotificationHistoryItem,
  UserNotificationPreference,
  WebAuthnPasskey,
} from "@k2b/cloud/contracts";
import type { ApprovalPage, PendingApproval } from "@k2b/cloud/contracts/approvals";

// Invented, dense sample data for the account pages as a person with a working account sees them: several apps that
// notify, a few passkeys and keys (one about to expire), devices, groups and a month of account events. Nobody real;
// dates sit around the tests' fixed `now` (30 September 2026, 10:00 UTC).

const at = (iso: string) => `2026-${iso}:00.000Z`;
const id = (prefix: string, index: number) => `00000000-0000-4000-8000-${prefix}${String(index).padStart(12 - prefix.length, "0")}`;

/** The apps of the installation, as the runtime knows them: names, symbols and colours for the rail and the sections. */
export const runtimeApps = [
  // Core itself, as its declaration names it; it has no entry of its own in the rail.
  { id: "core", name: "Cloud", icon: "ti ti-cloud", color: "#0284c7", rail: false },
  { id: "mail", name: "Mail", icon: "ti ti-mail", color: "#2563eb" },
  { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban", color: "#16a34a" },
  { id: "files", name: "Dateien", icon: "ti ti-folder", color: "#d97706" },
  { id: "notebooks", name: "Notizen", icon: "ti ti-notebook", color: "#7c3aed" },
  { id: "chat", name: "Chat", icon: "ti ti-message-circle", color: "#db2777" },
].map((app: { id: string; name: string; icon: string; color: string; rail?: boolean }) => ({
  id: app.id,
  name: app.name,
  icon: app.icon,
  description: "",
  baseUrl: `http://${app.id}:3000`,
  routes: [`/app/${app.id}`],
  appearance: { accent: app.color as `#${string}` },
  ...(app.rail === false ? {} : { nav: { href: `/app/${app.id}`, section: "primary" as const } }),
}));

export const passkeys = (userId: string): WebAuthnPasskey[] => [
  {
    id: id("2", 1),
    userId,
    name: "Arbeitslaptop",
    transports: ["internal"],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: at("03-02T08:15"),
    lastUsedAt: at("09-30T09:12"),
  },
  {
    id: id("2", 2),
    userId,
    name: "iPhone",
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: at("05-14T18:40"),
    lastUsedAt: at("09-28T07:55"),
  },
  {
    id: id("2", 3),
    userId,
    name: "YubiKey 5C",
    transports: ["usb", "nfc"],
    deviceType: "singleDevice",
    backedUp: false,
    createdAt: at("01-09T10:00"),
    lastUsedAt: at("08-11T16:20"),
  },
];

const key = (index: number, name: string, scopes: string[], expiresAt: string | null, lastUsedAt: string | null) =>
  ({
    id: id("1", index),
    serviceAccountId: id("1", 99),
    name,
    kind: "api_token",
    status: "active",
    tokenPrefix: ["cld_7f3a", "cld_9b2c", "cld_41de", "cld_c08b"][index - 1] ?? "cld_0000",
    scopes,
    expiresAt,
    lastUsedAt,
    createdBy: null,
    createdAt: at("06-01T09:00"),
    revokedAt: null,
    revokedBy: null,
  }) as ServiceAccountCredential;

export const apiKeys: ServiceAccountCredential[] = [
  key(1, "Laptop-Skripte", [], at("12-31T00:00"), at("09-30T08:02")),
  key(2, "Diktier-App", ["ai:inference"], null, at("09-29T17:45")),
  key(3, "Backup-Job Fachschaft", [], at("10-12T00:00"), at("09-30T03:00")),
  key(4, "Kalender-Sync", [], "2027-03-01T00:00:00.000Z", null),
];

export const appDevices: AppDeviceView[] = [
  { id: id("3", 1), name: "Pixel 8", createdAt: at("04-20T12:00"), lastUsedAt: at("09-30T09:12"), revokedAt: null, assisted: false },
  { id: id("3", 2), name: "iPad Air", createdAt: at("07-02T19:30"), lastUsedAt: at("09-21T20:05"), revokedAt: null, assisted: true },
];

/** A month of account events, newest first. */
export const accountEvents = [
  ["09-30T09:12", "webauthn_credential.authenticate", "Arbeitslaptop"],
  ["09-30T08:02", "service_account_credential.authenticate", "Laptop-Skripte"],
  ["09-28T07:55", "webauthn_credential.authenticate", "iPhone"],
  ["09-27T23:14", "webauthn_credential.authenticate", "Unbekannter Sicherheitsschlüssel", "denied"],
  ["09-24T14:31", "accounts.user.update", "Telefonnummer"],
  ["09-21T20:05", "auth.pwa.device.enroll", "iPad Air"],
  ["09-15T11:40", "service_account_credential.create", "Backup-Job Fachschaft"],
  ["09-09T16:12", "webauthn_credential.delete", "Alter Laptop"],
  ["09-02T08:47", "accounts.user.change_own_password", null],
].map(([time, action, context, outcome], index) => ({
  id: index + 1,
  createdAt: at(time as string),
  action: action as string,
  label: action as string,
  outcome: (outcome ?? "allowed") as "allowed" | "denied" | "failed",
  context: context ?? null,
}));

const preference = (
  appId: string,
  kind: string,
  label: string,
  description: string,
  selected: string[],
  customized = false,
): UserNotificationPreference =>
  ({
    id: `${appId}.${kind}`,
    appId,
    kind,
    label,
    description,
    recommendedChannels: ["email", "browser"],
    requiredChannels: [],
    excludedChannels: [],
    excludedReason: null,
    selectedChannels: selected,
    effectiveChannels: selected,
    customized,
  }) as UserNotificationPreference;

export const notificationPreferences = {
  availableChannels: ["email", "browser"],
  definitions: [
    preference("mail", "new-mail", "Neue Mail", "Wenn eine Mail in deinem Posteingang ankommt.", ["browser"], true),
    preference("mail", "rule-failed", "Regel fehlgeschlagen", "Wenn eine Filterregel eine Mail nicht verschieben konnte.", ["email"]),
    preference("spaces", "assigned", "Dir zugewiesen", "Wenn dir jemand eine Karte zuweist.", ["email", "browser"]),
    preference("spaces", "due", "Fällig", "Am Morgen, an dem eine deiner Karten fällig ist.", ["email"]),
    preference("spaces", "mention", "Erwähnung", "Wenn dich jemand in einem Kommentar nennt.", [], true),
    preference("files", "shared", "Mit dir geteilt", "Wenn jemand einen Ordner oder eine Datei mit dir teilt.", ["email"]),
    preference("files", "storage-full", "Speicher fast voll", "Wenn dein Speicher zu 90 % belegt ist.", ["email"]),
    preference("chat", "direct", "Direktnachricht", "Wenn dir jemand direkt schreibt.", ["browser"]),
    preference("core", "account-expiry", "Ablauf des Kontos", "Bevor dein Konto abläuft.", ["email"]),
  ],
};

const delivery = (
  index: number,
  appId: string,
  label: string,
  title: string,
  channel: string,
  status: UserNotificationHistoryItem["status"],
  time: string,
  error: string | null = null,
): UserNotificationHistoryItem => ({
  id: id("4", index),
  eventId: id("5", index),
  definitionId: `${appId}.${label}`,
  appId,
  label,
  title,
  targetHref: `/app/${appId}`,
  channel,
  destinationLabel: channel === "email" ? "jonas.beispiel@example.org" : "Arbeitslaptop",
  required: false,
  status,
  attemptCount: status === "failed" ? 3 : 1,
  errorCode: error ? "provider_error" : null,
  errorMessage: error,
  createdAt: at(time),
  deliveredAt: status === "delivered" ? at(time) : null,
});

export const deliveries: UserNotificationHistoryItem[] = [
  delivery(1, "spaces", "Dir zugewiesen", "Lena Hoffmann hat dir „Aushang Sommerfest“ zugewiesen", "email", "delivered", "09-30T09:40"),
  delivery(2, "mail", "Neue Mail", "Neue Mail von Erik Sander: Protokoll der Sitzung", "browser", "delivered", "09-30T09:05"),
  delivery(3, "chat", "Direktnachricht", "Mira Okafor: Kannst du heute um 14 Uhr?", "browser", "deferred", "09-30T08:31"),
  delivery(4, "files", "Mit dir geteilt", "Tom Becker hat „Haushalt 2027“ mit dir geteilt", "email", "delivered", "09-29T17:12"),
  delivery(
    5,
    "spaces",
    "Fällig",
    "„Raum für die Vollversammlung buchen“ ist heute fällig",
    "email",
    "failed",
    "09-29T07:00",
    "550 5.1.1 Mailbox unavailable",
  ),
  delivery(
    6,
    "mail",
    "Regel fehlgeschlagen",
    "Die Regel „Rechnungen“ konnte 2 Mails nicht verschieben",
    "email",
    "delivered",
    "09-28T22:14",
  ),
  delivery(7, "spaces", "Erwähnung", "Ada Renz hat dich in „Plakate drucken“ erwähnt", "browser", "delivered", "09-28T15:48"),
  delivery(8, "files", "Speicher fast voll", "Dein Speicher ist zu 91 % belegt", "email", "suppressed", "09-27T06:00"),
  delivery(9, "chat", "Direktnachricht", "Felix Thal: Danke dir!", "browser", "delivered", "09-26T19:33"),
  delivery(10, "spaces", "Dir zugewiesen", "Lena Hoffmann hat dir „Getränke bestellen“ zugewiesen", "email", "delivered", "09-26T11:02"),
  delivery(11, "mail", "Neue Mail", "Neue Mail von Studierendenwerk: Rückmeldung", "browser", "delivered", "09-25T08:20"),
  delivery(12, "core", "Ablauf des Kontos", "Dein Konto läuft am 31. März 2027 ab", "email", "delivered", "09-24T09:00"),
];

const approval = (
  index: number,
  values: Pick<PendingApproval, "app" | "action" | "sentence" | "requester"> & { sends: string; to: string },
): PendingApproval => ({
  id: id("6", index),
  app: values.app,
  action: values.action,
  assurance: "confirm",
  sentence: values.sentence,
  review: {
    locale: "de",
    sentence: { action: values.sends, running: values.sends, done: values.sends, confirm: values.sends, decline: "Nicht ausführen" },
    slots: {},
    ask: "sends",
    view: { version: 1, blocks: [{ kind: "Detail", title: "Details", items: [{ label: "An", value: values.to }] }] },
  },
  requester: values.requester,
  remember: { chat: false, always: false, website: false },
  createdAt: at("09-30T09:20"),
  expiresAt: at("10-01T09:20"),
});

/** Two actions that wait for the person's decision: a mail to send and a card to move. */
export const openApprovals: ApprovalPage = {
  items: [
    approval(1, {
      app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
      action: "draft.send",
      sentence: "Mail: Den Entwurf „Einladung Sommerfest“ an 48 Empfänger senden",
      sends: "Einladung senden",
      to: "fachschaft@example.org",
      requester: { kind: "chat", appId: "assistant", title: "Einladung Sommerfest", href: "/app/assistant?conversation=c1" },
    }),
    approval(2, {
      app: { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban" },
      action: "card.move",
      sentence: "Spaces: 12 Karten von „Planung“ nach „Erledigt“ verschieben",
      sends: "Karten verschieben",
      to: "Board Sommerfest",
      requester: { kind: "chat", appId: "assistant", title: "Aufräumen im Board", href: "/app/assistant?conversation=c2" },
    }),
  ],
  nextCursor: null,
  count: 2,
  elsewhere: 0,
};
