/**
 * Fictional apps for the Apps page's browser fixture: the apps and states of the approved mockup
 * (apps-zusammenfuehren-mockup v1). Times are relative to `FIXTURE_NOW`, which the fixture freezes.
 */
import type { AppDetails } from "@k2b/cloud/contracts";
import type { AppDomainEntry } from "./domains-model";
import type { StartRejection } from "./Keys.island";
import type { KeyEntry } from "./keys-dialogs";
import type { AppInput, ProviderNumbers } from "./model";

export const FIXTURE_NOW = Date.parse("2026-10-30T14:30:00.000Z");
const ago = (minutes: number) => new Date(FIXTURE_NOW - minutes * 60_000).toISOString();
export const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const gateway = { appId: "gateway-ops", name: "Gateway" };
const PULSE_KEY_ID = "44444444-4444-4444-8444-444444444445";
/** Pulse's refused start three minutes ago, with its revoked key (key mockup v3, "Problem: Start abgelehnt"). */
export const fixtureRejection = (id: string, reason: StartRejection["reason"] = "revoked"): StartRejection | null =>
  id === "pulse" ? { at: ago(3), reason, keyId: PULSE_KEY_ID } : null;

const numbers = (requests: number, errors: number, avgMs: number, minutes = 1): ProviderNumbers[] => [
  {
    provider: gateway,
    traffic: { requests, errors, avgMs },
    links: [
      { label: "Protokolle", href: "/admin/observability/logs", kind: "logs" },
      { label: "Metriken", href: "/admin/observability/telemetry", kind: "metrics" },
      { label: "Alle Routen", href: "/admin/observability/gateway/routes", kind: "routes" },
      { label: "Capabilities", href: "/admin/observability/capabilities", kind: "capabilities" },
    ],
    lastSeenAt: ago(minutes),
  },
];

const base = (input: Partial<AppInput> & Pick<AppInput, "id" | "name" | "icon" | "accent" | "description">): AppInput => ({
  live: true,
  heartbeatStale: false,
  release: "0.53.0",
  routes: [`/${input.id}`, `/api/${input.id}`],
  adminHref: `/admin/${input.id}`,
  logsHref: "/admin/observability/logs",
  instances: 2,
  firstSeenAt: "2026-09-01T08:00:00.000Z",
  lastSeenAt: ago(0),
  firstKnownAt: "2026-09-01T08:00:00.000Z",
  coreKnows: true,
  accessKind: "signedIn",
  access: null,
  keys: { active: 1, expired: 0, revoked: 0, lastUsedAt: ago(3), accountStatus: "active" },
  keysSupported: true,
  keysKnown: true,
  startRejected: null,
  startsWithEnv: false,
  failedDeliveries: 0,
  runtimeIssues: [],
  missingRoutes: [],
  numbers: numbers(1000, 0, 40),
  numbersUnavailable: false,
  ...input,
});

export const fixtureApps = (): AppInput[] => [
  base({
    id: "chat",
    name: "Chat",
    icon: "ti ti-message-circle",
    accent: "#0e7490",
    description: "Nachrichten und Kanäle für Teams.",
    routes: ["/chat", "/api/chat"],
    adminHref: null,
    numbers: numbers(7190, 0, 31),
  }),
  base({
    id: "files",
    name: "Dateien",
    icon: "ti ti-folder",
    accent: "#854d0e",
    description: "Dateien ablegen, teilen und gemeinsam bearbeiten.",
    routes: ["/files", "/api/files", "/s", "/dav"],
    accessKind: "resources",
    // Still starts with its environment: running, no key yet.
    keys: { active: 0, expired: 0, revoked: 0, lastUsedAt: null, accountStatus: null },
    startsWithEnv: true,
    numbers: numbers(13_610, 6, 62),
  }),
  base({
    id: "grids",
    name: "Grids",
    icon: "ti ti-table",
    accent: "#166534",
    description: "Tabellen und Datenbanken ohne Programmieren.",
    accessKind: "grants",
    access: { people: 31, groups: 2, serviceAccounts: 0, managers: 2 },
    keys: { active: 2, expired: 0, revoked: 0, lastUsedAt: ago(1), accountStatus: "active" },
    failedDeliveries: 3,
    numbers: numbers(6640, 286, 210),
  }),
  base({
    id: "inventar",
    name: "inventar",
    icon: "ti ti-apps",
    accent: null,
    description: "Core kennt diese App erst nach ihrem ersten Start.",
    live: false,
    release: null,
    routes: [],
    adminHref: null,
    logsHref: null,
    instances: null,
    firstSeenAt: null,
    lastSeenAt: null,
    firstKnownAt: "2026-10-29T10:00:00.000Z",
    accessKind: null,
    keys: { active: 0, expired: 0, revoked: 0, lastUsedAt: null, accountStatus: "active" },
    numbers: [],
  }),
  base({
    id: "lager",
    name: "Lagerbestand",
    icon: "ti ti-packages",
    accent: "#9a3412",
    description: "Bestände und Lagerorte für Werkstatt und Laden.",
    release: "2.4.1",
    accessKind: "grants",
    access: { people: 8, groups: 1, serviceAccounts: 0, managers: 1 },
    keys: { active: 1, expired: 0, revoked: 0, lastUsedAt: ago(9), accountStatus: "active" },
    numbers: numbers(2084, 1, 55),
  }),
  base({
    id: "mail",
    name: "Mail",
    icon: "ti ti-mail",
    accent: "#1e40af",
    description: "E-Mail für Teams mit geteilten Postfächern.",
    routes: ["/mail", "/api/mail", "/mail-assets", "/.well-known/jmap"],
    accessKind: "grants",
    access: { people: 52, groups: 3, serviceAccounts: 0, managers: 1 },
    keys: { active: 1, expired: 0, revoked: 0, lastUsedAt: ago(4), accountStatus: "active" },
    numbers: numbers(12_400, 24, 48),
  }),
  base({
    id: "notebooks",
    name: "Notebooks",
    icon: "ti ti-notebook",
    accent: "#6b21a8",
    description: "Notizbücher mit Seiten, Verknüpfungen und Kommentaren.",
    keys: { active: 0, expired: 0, revoked: 1, lastUsedAt: ago(400), accountStatus: "active" },
    numbers: numbers(9320, 3, 40),
  }),
  base({
    id: "pulse",
    name: "Pulse",
    icon: "ti ti-activity",
    accent: "#9d174d",
    description: "Kurze Umfragen und Stimmungsbilder.",
    live: false,
    release: "0.52.1",
    instances: null,
    lastSeenAt: "2026-10-30T13:02:00.000Z",
    adminHref: null,
    keys: { active: 0, expired: 0, revoked: 1, lastUsedAt: ago(90), accountStatus: "active" },
    startRejected: fixtureRejection("pulse"),
    numbers: numbers(0, 0, 0, 88),
  }),
  base({
    id: "spaces",
    name: "Spaces",
    icon: "ti ti-layout-kanban",
    accent: "#3730a3",
    description: "Aufgaben, Termine und Projekte im Team.",
    routes: ["/spaces", "/api/spaces", "/caldav"],
    accessKind: "noGuests",
    missingRoutes: [{ prefix: "/caldav", owner: "Dateien" }],
    numbers: numbers(14_900, 13, 52),
  }),
  base({
    id: "tools",
    name: "Tools",
    icon: "ti ti-tool",
    accent: "#115e59",
    description: "Kleine Werkzeuge: QR-Codes, Umrechner, Zufallszahlen.",
    adminHref: null,
    accessKind: "grants",
    access: { people: 7, groups: 1, serviceAccounts: 0, managers: 0 },
    keys: { active: 1, expired: 0, revoked: 0, lastUsedAt: ago(20), accountStatus: "active" },
    numbers: numbers(760, 0, 22),
  }),
  base({
    id: "wiki",
    name: "wiki",
    icon: "ti ti-apps",
    accent: null,
    description: "Nur dem Gateway bekannt. Core hat zu dieser App keine Daten.",
    live: false,
    release: "0.41.0",
    routes: ["/wiki"],
    adminHref: null,
    instances: null,
    firstSeenAt: null,
    lastSeenAt: null,
    firstKnownAt: null,
    coreKnows: false,
    accessKind: null,
    keys: { active: 0, expired: 0, revoked: 0, lastUsedAt: null, accountStatus: null },
    numbers: [{ provider: gateway, traffic: { requests: 0, errors: 0, avgMs: null }, links: [], lastSeenAt: "2026-09-14T10:00:00.000Z" }],
  }),
];

export const fixtureDetails = (id: string, name: string): AppDetails => ({
  app: { id, name, description: null, icon: null, accent: null, online: true },
  access: {
    kind: "grants",
    roles: [],
    grantCount: 4,
    platformPermissions: id === "mail" ? ["mail:send", "mail:read"] : id === "lager" || id === "spaces" ? ["mail:send"] : [],
  },
  hears:
    id === "grids"
      ? [
          {
            subscriptionId: "grids:contacts.contact.updated@1",
            eventType: "contacts.contact.updated",
            version: 1,
            publisherAppId: "contacts",
            title: "Kontakt geändert",
            state: "active",
            reason: null,
            firstSeenAt: "2026-09-01T08:00:00.000Z",
            isNew: false,
            counts: { pending: 0, retrying: 0, done: 412, failed: 3, cancelled: 0 },
            failedDeliveries: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                eventId: "33333333-3333-4333-8333-333333333333",
                code: "HTTP 500",
                lastError: 'column "contact_ref" does not exist',
                attempts: 5,
                lastAttemptAt: "2026-10-30T12:58:00.000Z",
              },
              {
                id: "22222222-2222-4222-8222-222222222223",
                eventId: "33333333-3333-4333-8333-333333333334",
                code: "HTTP 500",
                lastError: 'column "contact_ref" does not exist',
                attempts: 5,
                lastAttemptAt: "2026-10-30T12:41:00.000Z",
              },
            ],
          },
          {
            subscriptionId: "grids:files.file.moved@2",
            eventType: "files.file.moved",
            version: 2,
            publisherAppId: "files",
            title: "Datei verschoben",
            state: "active",
            reason: null,
            firstSeenAt: "2026-09-01T08:00:00.000Z",
            isNew: false,
            counts: { pending: 0, retrying: 0, done: 1204, failed: 0, cancelled: 0 },
            failedDeliveries: [],
          },
          {
            subscriptionId: "grids:core.user.removed@1",
            eventType: "core.user.removed",
            version: 1,
            publisherAppId: "core",
            title: "Person entfernt",
            state: "active",
            reason: null,
            firstSeenAt: "2026-10-28T08:00:00.000Z",
            isNew: true,
            counts: { pending: 0, retrying: 0, done: 2, failed: 0, cancelled: 0 },
            failedDeliveries: [],
          },
        ]
      : [],
  sends: ["Zeile angelegt", "Zeile geändert", "Tabelle exportiert", "Zeile gelöscht", "Ansicht geteilt", "Formular abgeschickt"]
    .slice(0, id === "grids" ? 6 : id === "mail" ? 2 : 1)
    .map((title, index) => ({
      type: `${id}.${["row.created", "row.updated", "table.exported", "row.deleted", "view.shared", "form.submitted"][index]}`,
      version: 1,
      title,
      description: "",
      subject: `${id}.row`,
      place: index === 1 ? "grids.table" : null,
      automation: true,
      subscriberCount: [2, 1, 0, 0, 1, 3][index]!,
    })),
  notifications: [
    {
      id: "assigned",
      kind: "assigned",
      label: "Zeile zugewiesen",
      description: "",
      recipientKind: "user" as const,
      requiredChannels: [],
      recommendedChannels: ["E-Mail", "Push"],
      excludedChannels: [],
      excludedReason: null,
    },
    {
      id: "exported",
      kind: "exported",
      label: "Export fertig",
      description: "",
      recipientKind: "user" as const,
      requiredChannels: ["In der App"],
      recommendedChannels: [],
      excludedChannels: [],
      excludedReason: null,
    },
  ].slice(0, id === "chat" ? 0 : 2),
  totals: { sends: id === "grids" ? 6 : id === "mail" ? 2 : 1, hears: id === "grids" ? 3 : 0, notifications: id === "chat" ? 0 : 2 },
});

const key = (input: Partial<KeyEntry> & Pick<KeyEntry, "keyId" | "name" | "fingerprint">): KeyEntry => ({
  publicKey: "Zm9yLWZpeHR1cmUtdXNlLW9ubHktbm90LWEtcmVhbC1rZXk",
  status: "active",
  createdAt: "2026-10-12T09:00:00.000Z",
  createdBy: ADMIN_ID,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: ago(4),
  ...input,
});

/** Pulse's replacement after the refusal: created, not yet in the deployment. */
export const fixtureReplacementKey = (): KeyEntry =>
  key({
    keyId: "44444444-4444-4444-8444-444444444446",
    name: "pulse-2026-10",
    fingerprint: "5b0e9c2d7a1f43e8b6d0c9a2e4f17b38",
    createdAt: ago(1),
    lastUsedAt: null,
  });

export const fixtureKeys = (id: string): KeyEntry[] => {
  if (id === "inventar" || id === "files") return [];
  if (id === "pulse")
    return [
      key({
        keyId: PULSE_KEY_ID,
        name: "pulse-prod",
        fingerprint: "9e214a0c73d5b1186a0e2c4d8f1b3a57",
        status: "revoked",
        createdAt: "2026-09-02T09:00:00.000Z",
        revokedAt: ago(438),
        lastUsedAt: ago(90),
      }),
    ];
  if (id === "notebooks")
    return [
      key({
        keyId: "44444444-4444-4444-8444-444444444441",
        name: "erststart",
        fingerprint: "0c557e18d3a921bf6a0e2c4d8f1b3a57",
        status: "revoked",
        createdAt: "2026-09-02T09:00:00.000Z",
        revokedAt: ago(320),
      }),
    ];
  const first = key({
    keyId: "44444444-4444-4444-8444-444444444442",
    name: "produktion-2026-10",
    fingerprint: "3f9ac21e77b05d14e8a2c6b09d31f7a4",
  });
  const revoked = key({
    keyId: "44444444-4444-4444-8444-444444444443",
    name: "erststart",
    fingerprint: "0c557e18d3a921bf6a0e2c4d8f1b3a57",
    status: "revoked",
    createdAt: "2026-09-02T09:00:00.000Z",
    revokedAt: "2026-10-12T09:10:00.000Z",
    lastUsedAt: "2026-10-11T09:00:00.000Z",
  });
  if (id === "grids")
    return [
      first,
      key({
        keyId: "44444444-4444-4444-8444-444444444444",
        name: "rotation-2026-11",
        fingerprint: "b81d0e4c9a27f360115e2d8c4a9b7e03",
        createdAt: ago(60),
        lastUsedAt: null,
      }),
      revoked,
    ];
  return [first, revoked];
};

/** Lagerbestand declares public pages: a primary domain, its www alias, and one whose certificate is still missing. */
export const fixtureDomains = (): AppDomainEntry[] => {
  const healthy = (minutes: number) => ({
    checkedAt: ago(minutes),
    dns: { ok: true, detail: "203.0.113.10" },
    certificate: { ok: true, detail: "Valid TLS certificate for this host" },
    reachable: { ok: true, detail: "Cloud gateway returned the challenge" },
  });
  return [
    { host: "lager.example.de", redirectTo: null, createdAt: "2026-10-20T09:00:00.000Z", active: true, status: healthy(12) },
    {
      host: "www.lager.example.de",
      redirectTo: "lager.example.de",
      createdAt: "2026-10-20T09:05:00.000Z",
      active: true,
      status: healthy(12),
    },
    {
      host: "bestand.example.de",
      redirectTo: null,
      createdAt: "2026-10-30T13:00:00.000Z",
      active: true,
      status: {
        checkedAt: ago(30),
        dns: { ok: true, detail: "203.0.113.10" },
        certificate: { ok: false, detail: "certificate has expired" },
        reachable: null,
      },
    },
  ];
};
