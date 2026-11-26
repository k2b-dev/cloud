import type { OAuthClient } from "@/contracts";
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
    scopes: ["read"],
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
