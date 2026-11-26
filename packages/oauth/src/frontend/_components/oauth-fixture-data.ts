import type { OAuthClient } from "@/contracts";
import type { ClientConnections, ConnectionFigures } from "../../service/connections";
import type { ClientRow } from "./OAuthScreen";

// Invented clients for render and browser tests and pictures: fixed dates, no production data. The secrets are fakes
// that say so. `WORST` carries long names, descriptions and addresses, every scope, many users and groups, and a
// whole page of clients.

/** What a test or a picture shows as a freshly made secret: plainly not a real one. */
// invented for tests and pictures; it opens nothing
export const FAKE_SECRET = "oc_sk_7Kp2Vx9mQ4rT8wL3sB6dF1hJ5yC0zN2eG4aR8uW";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
/** Eight hex signs that look random but stay the same for an index. */
const hex = (index: number, factor: number) => (Math.imul(index + 1, factor) >>> 0).toString(16).padStart(8, "0");
/** A client ID as the service makes one (a random UUID), the same for an index in every run. */
const clientUuid = (index: number) =>
  `${hex(index, 0x9e3779b1)}-${hex(index, 0x85ebca77).slice(0, 4)}-4${hex(index, 0xc2b2ae3d).slice(1, 4)}-a${hex(index, 0x27d4eb2f).slice(1, 4)}-${hex(index, 0x165667b1)}${hex(index, 0x7feb352d).slice(0, 4)}`;
/** The list's dates fall with its order, as the service lists the newest first. */
const createdOn = (index: number) => `2026-11-${String(25 - (index % 15)).padStart(2, "0")}T08:00:00.000Z`;

export const fixtureClient = (index: number, values: Partial<OAuthClient> & { name: string }): ClientRow => ({
  id: id(index),
  description: null,
  clientId: clientUuid(index),
  redirectUris: [],
  logoutUri: null,
  scopes: ["openid", "profile", "email"],
  audiences: ["cloud"],
  serviceAccountId: null,
  allowedProfiles: ["user"],
  accessMode: "profiles",
  accessUsers: [],
  accessGroups: [],
  registrationKind: "managed",
  isPublic: false,
  allowDeviceGrant: false,
  createdBy: null,
  ...values,
  createdAt: values.createdAt ?? createdOn(index),
  // the date as the page words it (`formatDate`, German)
  created: new Date(values.createdAt ?? createdOn(index)).toLocaleDateString("de-DE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }),
});

const person = (index: number, displayName: string) => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  uid: displayName.toLowerCase().replace(/\s+/g, "."),
  displayName,
  mail: `${displayName.toLowerCase().replace(/\s+/g, ".")}@werkstatt.example`,
  provider: "local" as const,
});
const team = (index: number, name: string) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  name,
  description: null,
  provider: "local" as const,
});

export const NORMAL: ClientRow[] = [
  fixtureClient(1, {
    name: "Cloud CLI",
    clientId: "cloud-cli",
    description: "Anmeldung im Terminal mit cld login",
    registrationKind: "first_party",
    isPublic: true,
    allowDeviceGrant: true,
    redirectUris: ["http://127.0.0.1/callback"],
    scopes: ["openid", "profile", "email", "offline_access", "read", "write"],
    allowedProfiles: ["user", "guest"],
  }),
  fixtureClient(2, {
    name: "Grafana",
    description: "Dashboards der Werkstatt",
    redirectUris: ["https://grafana.werkstatt.example/login/generic_oauth"],
    logoutUri: "https://grafana.werkstatt.example/logout",
    scopes: ["openid", "profile", "email", "groups"],
  }),
  fixtureClient(3, {
    name: "Paperless",
    description: "Belegablage der Buchhaltung",
    redirectUris: ["https://belege.werkstatt.example/accounts/oidc/cloud/login/callback/"],
    accessMode: "specific",
    accessUsers: [person(1, "Ada Renz")],
    accessGroups: [team(1, "buchhaltung")],
  }),
  fixtureClient(4, {
    name: "Wiki",
    description: "Handbuch und Anleitungen",
    isPublic: true,
    redirectUris: ["https://wiki.werkstatt.example/login/callback"],
    allowedProfiles: ["user", "guest"],
  }),
  fixtureClient(5, {
    name: "Claude Code",
    registrationKind: "dynamic",
    isPublic: true,
    redirectUris: ["http://localhost:53682/callback"],
    scopes: ["read", "write", "offline_access"],
    allowedProfiles: ["user", "guest"],
  }),
  fixtureClient(6, { name: "Nextcloud", description: "Dateiablage für Partner", allowedProfiles: ["guest"] }),
  fixtureClient(7, {
    name: "Drucker-Terminal",
    description: "Anmeldung am Gerät mit Code",
    isPublic: true,
    allowDeviceGrant: true,
    scopes: ["openid", "profile"],
  }),
  fixtureClient(8, { name: "Zeiterfassung", description: "Stempeluhr in Halle 2", scopes: ["openid", "profile", "email", "groups"] }),
  fixtureClient(9, { name: "Backup-Agent", description: null, scopes: ["read"], allowedProfiles: [] }),
  fixtureClient(10, {
    name: "MCP Inspector",
    registrationKind: "dynamic",
    isPublic: true,
    redirectUris: ["http://localhost:6274/oauth/callback"],
    scopes: ["read", "offline_access"],
    allowedProfiles: ["user", "guest"],
  }),
];

const LONG = "Kunden & Aufträge (Werkstatt Nord) – interne Zeiterfassung, Materialbestellung und Auftragsarchiv";

export const WORST: ClientRow[] = [
  fixtureClient(100, {
    name: LONG,
    description:
      "Meldet Mitarbeitende der Werkstatt Nord bei der Zeiterfassung, der Materialbestellung und dem Auftragsarchiv an, auch auf den Tablets in der Halle",
    redirectUris: Array.from(
      { length: 5 },
      (_, index) => `https://auftraege-werkstatt-nord.intern.werkstatt-nord.example/anmeldung/oauth2/rueckruf/standort-${index + 1}`,
    ),
    logoutUri: "https://auftraege-werkstatt-nord.intern.werkstatt-nord.example/abmeldung/fertig",
    scopes: ["openid", "profile", "email", "groups", "offline_access", "read", "write", "admin"],
    accessMode: "specific",
    accessUsers: Array.from({ length: 6 }, (_, index) => person(100 + index, `Mitarbeiterin mit langem Namen ${index + 1}`)),
    accessGroups: Array.from({ length: 6 }, (_, index) => team(100 + index, `werkstatt-nord-schicht-${index + 1}`)),
  }),
  fixtureClient(101, { name: "X", registrationKind: "dynamic", isPublic: true, scopes: ["read"], allowedProfiles: ["user", "guest"] }),
  ...Array.from({ length: 48 }, (_, index) =>
    fixtureClient(102 + index, {
      name: `Standort ${String(index + 1).padStart(3, "0")} · Kasse`,
      description: index % 3 ? `Kassensystem am Standort ${index + 1}` : null,
      isPublic: index % 4 === 0,
      registrationKind: index % 7 === 0 ? "dynamic" : "managed",
    }),
  ),
];

// ── Connections ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Invented connections for the pictures and tests, relative to now, so a relative time reads the same on any day.

const MINUTE = 60 * 1000;
const PEOPLE = ["Ada Renz", "Jana Berger", "Tom Ochs", "Lena Hartwig", "Mira Sander", "Sami Yilmaz", "Felix Thal", "Jonas Kern"];
/** Active connections and minutes since the last use, by client name; the rest get a small share. */
const USE: Record<string, { active: number; minutesAgo: number | null }> = {
  Wiki: { active: 58, minutesAgo: 3 },
  "Cloud CLI": { active: 41, minutesAgo: 2 },
  Zeiterfassung: { active: 31, minutesAgo: 9 },
  Grafana: { active: 23, minutesAgo: 6 },
  Nextcloud: { active: 12, minutesAgo: 16 * 60 },
  Paperless: { active: 6, minutesAgo: 60 },
  "Drucker-Terminal": { active: 4, minutesAgo: 3 * 60 },
  "Claude Code": { active: 3, minutesAgo: 20 },
  "Backup-Agent": { active: 0, minutesAgo: null },
  "MCP Inspector": { active: 0, minutesAgo: 34 * 24 * 60 },
};
/** Thirty days of new connections that roughly add up to a client's connections, the same for a name every time. */
const days = (seed: number, active: number) =>
  Array.from({ length: 30 }, (_, day) => {
    const wave = Math.abs(Math.sin(seed * 7.1 + day * 1.7));
    return active === 0 ? 0 : Math.round(wave * Math.max(1, active / 12)) * (day % 6 === 5 ? 0 : 1);
  });

/** The connections of a list of clients as the service returns them, by client ID. */
export const fixtureConnections = (clients: readonly ClientRow[]): Record<string, ClientConnections> =>
  Object.fromEntries(
    clients.map((client, index) => {
      const use = USE[client.name] ?? { active: 1 + ((index * 7) % 13), minutesAgo: 30 + index * 11 };
      const people = PEOPLE.slice(index % 4, (index % 4) + Math.min(3, use.active)).map((name) => ({ name }));
      return [
        client.clientId,
        {
          active: use.active,
          peopleCount: Math.min(use.active, Math.max(people.length, Math.ceil(use.active * 0.6))),
          people,
          perDay: days(index + 1, use.active),
          lastUsedAt: use.minutesAgo === null ? null : new Date(Date.now() - use.minutesAgo * MINUTE).toISOString(),
        },
      ];
    }),
  );

/** The figures of all connections for a list of clients. */
export const fixtureActivity = (clients: readonly ClientRow[], worst = false): ConnectionFigures => {
  const connections = Object.values(fixtureConnections(clients));
  const perDay = Array.from({ length: 30 }, (_, day) => connections.reduce((sum, client) => sum + (client.perDay[day] ?? 0), 0));
  return worst
    ? { active: 98_765, people: 12_345, newLast7: 4_321, perDay, unused: { count: 1_234, names: [clients[0]!.name, "X"] } }
    : {
        active: connections.reduce((sum, client) => sum + client.active, 0),
        people: 97,
        newLast7: perDay.slice(-7).reduce((sum, count) => sum + count, 0),
        perDay,
        unused: { count: 1, names: ["MCP Inspector"] },
      };
};
