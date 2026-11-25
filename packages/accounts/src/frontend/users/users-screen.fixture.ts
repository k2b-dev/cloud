import type { AccountDirectoryEntry, AccountDirectoryPerson } from "@k2b/cloud/contracts";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { directoryQueryOf, type UsersState } from "./query";

// Invented sample data for the account list's browser test and design review: a fixed "now", fixed IDs, no real people.

export const FIXTURE_NOW = "2026-11-25T12:00:00.000Z";
export const FIXTURE_TIME_ZONE = "Europe/Berlin";

const group = (index: number, name: string) => ({ id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, name });
export const FIXTURE_GROUPS = {
  office: group(1, "Büro"),
  sales: group(2, "Verkauf"),
  store: group(3, "Lager"),
  board: group(4, "Geschäftsführung"),
  temps: group(5, "Aushilfen"),
  workshop: group(6, "Werkstatt"),
};
const G = FIXTURE_GROUPS;

const daysAgo = (days: number) => new Date(Date.parse(FIXTURE_NOW) - days * 86_400_000).toISOString();
const DOMAIN = "solberg-kramer.example";

type Seed = {
  name: string;
  role: AccountDirectoryPerson["role"];
  groups: { id: string; name: string }[];
  last: number | null;
  passkey: boolean;
  uid?: string;
  mail?: string | null;
  provider?: "local" | "ipa";
  expired?: boolean;
  /** A picture that does not load: the initials stay. */
  avatarHash?: string;
};
const person = (seed: Seed, index: number, prefix = "22222222-2222-4222-8222-"): AccountDirectoryPerson => {
  const words = seed.name.trim().split(/\s+/);
  const given = words[0] ?? "";
  const family = words.at(-1) ?? "";
  const uid = seed.uid ?? `${given.charAt(0).toLowerCase()}.${family.toLowerCase()}`;
  return {
    kind: "person",
    id: `${prefix}${String(index + 1).padStart(12, "0")}`,
    uid,
    roles: seed.role === "admin" ? ["user", "admin"] : seed.role === "guest" ? ["guest"] : ["user"],
    provider: seed.provider ?? (index % 4 === 3 ? "ipa" : "local"),
    profile: seed.role === "guest" ? "guest" : "user",
    givenname: given,
    sn: family,
    displayName: seed.name,
    mail: seed.mail === undefined ? `${uid}@${DOMAIN}` : seed.mail,
    avatarHash: seed.avatarHash ?? null,
    role: seed.role,
    status: seed.expired ? "expired" : seed.last === null ? "invited" : "active",
    lastLogin: seed.last === null ? null : daysAgo(seed.last),
    accountExpires: seed.expired ? daysAgo(10) : null,
    passkey: seed.passkey,
    groups: [...seed.groups].sort((a, b) => a.name.localeCompare(b.name, "de")),
    groupCount: seed.groups.length,
    duplicateMail: false,
  };
};

/** Marks every person whose address (trimmed, any case) another account of the sample shares, as the service does. */
const withSharedAddresses = (entries: AccountDirectoryEntry[]): AccountDirectoryEntry[] => {
  const address = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? entry.mail?.trim().toLowerCase() || null : null);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = address(entry);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.map((entry) =>
    entry.kind === "person" ? { ...entry, duplicateMail: (counts.get(address(entry) ?? "") ?? 0) > 1 } : entry,
  );
};

const seeds: Seed[] = [
  { name: "Hannah Stoll", role: "member", groups: [G.office], last: 18, passkey: false },
  { name: "Jonas Hartwig", role: "member", groups: [G.office], last: 37, passkey: true },
  { name: "Lina Vogt", role: "member", groups: [G.office], last: 5, passkey: false },
  { name: "Milan Horvat", role: "admin", groups: [G.board, G.sales], last: 42, passkey: false },
  { name: "Ada Renz", role: "admin", groups: [G.store], last: 11, passkey: true },
  { name: "Karl Bergmann", role: "member", groups: [G.store], last: 41, passkey: false },
  { name: "Vera Haas", role: "admin", groups: [G.temps], last: 27, passkey: false },
  { name: "Mira Solberg", role: "admin", groups: [G.board], last: 0, passkey: true },
  { name: "Petra Lindqvist", role: "member", groups: [G.workshop, G.sales], last: 2, passkey: true },
  { name: "Felix Thom", role: "guest", groups: [], last: null, passkey: false },
  { name: "Jana Kramer", role: "member", groups: [G.workshop], last: null, passkey: false },
  { name: "Henrik Brandt", role: "admin", groups: [G.workshop], last: 140, passkey: false, expired: true },
  { name: "Lea Oswald", role: "guest", groups: [G.temps], last: 3, passkey: false },
  { name: "Tobias Rombach", role: "member", groups: [G.sales], last: 96, passkey: true },
  // a second account for Jonas from FreeIPA, with his address written differently: the duplicate address check finds it
  {
    name: "Jonas Hartwig",
    role: "member",
    groups: [],
    last: 210,
    passkey: false,
    uid: "jhartwig",
    mail: ` J.Hartwig@${DOMAIN}`,
    provider: "ipa",
  },
];

const service = (
  index: number,
  kind: "agent" | "api-key",
  name: string,
  status: "active" | "disabled",
  lastUsed: number | null,
): AccountDirectoryEntry => ({
  kind,
  id: `0b2f5c7e-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name,
  status,
  avatarHash: null,
  lastUsed: lastUsed === null ? null : daysAgo(lastUsed),
  createdAt: daysAgo(90 + index),
});

export const FIXTURE_PEOPLE: AccountDirectoryPerson[] = seeds.map((seed, index) => person(seed, index));
export const FIXTURE_SERVICE_ACCOUNTS: AccountDirectoryEntry[] = [
  service(1, "agent", "Wochenbericht", "active", 1),
  service(2, "agent", "Festplaner", "active", null),
  service(3, "api-key", "Import Buchhaltung", "disabled", 60),
];
export const FIXTURE_ACCOUNTS: AccountDirectoryEntry[] = withSharedAddresses([...FIXTURE_PEOPLE, ...FIXTURE_SERVICE_ACCOUNTS]);

/** Groups at their limits (break-ui): a slug of 120 characters, a one-letter name, and enough for twelve in one row. */
const worstGroup = (index: number, name: string) => ({ id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, name });
export const WORST_GROUPS = [
  worstGroup(1, "verkauf-und-ankauf-laden-online-auktionshaus-sonderveranstaltungen-wochenende-und-feiertage-region-ortenau-nord"),
  worstGroup(2, "j"),
  ...Array.from({ length: 10 }, (_, index) =>
    worstGroup(index + 3, ["Büro", "Verkauf", "Lager", "Geschäftsführung", "Aushilfen"][index % 5]! + ` ${index + 1}`),
  ),
];

/**
 * The worst realistic accounts (break-ui): names at their limits (display name 160 characters), long, compound and
 * non-Latin names, unbreakable addresses, a one-letter name, a person without a name or address, an emoji name, markup
 * as a name, a picture that does not load, twelve groups, every status, a sign-in a moment in the future, and three
 * accounts on one address. With the sample padded to 1,284 accounts, the counts need their thousands separator.
 */
const worstSeeds: Seed[] = [
  {
    name: "Christopher Alexander Montgomery III von Oberhauser-Wettstein zu Hohenlohe-Langenburg und Waldenburg-Schillingsfürst",
    role: "admin",
    groups: WORST_GROUPS,
    last: 0,
    passkey: true,
    uid: "c.montgomery",
    mail: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  },
  {
    name: "Aleksandra Wiśniewska-Kowalczyk",
    role: "admin",
    groups: Object.values(G),
    last: 0,
    passkey: true,
    avatarHash: "missing-picture",
    mail: "aleksandra.wisniewska-kowalczyk@northwind-industries-holdings.example.com",
  },
  { name: "J", role: "guest", groups: [], last: null, passkey: false, uid: "j", mail: "a@b.test" },
  {
    name: "Christopher Alexander Montgomery III",
    role: "member",
    groups: [G.sales, G.store],
    last: 400,
    passkey: false,
    mail: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  },
  {
    name: "Bartholomew Fitzgerald",
    role: "member",
    groups: [G.board],
    last: 12,
    passkey: true,
    uid: "b.fitzgerald",
    mail: "Bartholomew.Fitzgerald@northwind-industries-holdings.example.com ",
    provider: "ipa",
  },
  { name: "Đặng Thị Ngọc Hân", role: "member", groups: [G.workshop], last: 29, passkey: false, uid: "dang.han" },
  { name: "王秀英", role: "member", groups: [G.office], last: 31, passkey: false, uid: "wang.xiuying" },
  { name: "نور الهدى عبد الرحمن", role: "guest", groups: [G.temps], last: 6, passkey: false, uid: "nour.abdelrahman" },
  { name: "🦊 Fox", role: "member", groups: [], last: -1, passkey: false, uid: "fox" },
  {
    name: "<script>alert(1)</script> &amp; **fett**",
    role: "member",
    groups: [WORST_GROUPS[1]!],
    last: 1100,
    passkey: false,
    uid: "markup",
  },
  { name: "", role: "member", groups: [], last: null, passkey: false, uid: "svc-scanner", mail: null },
  {
    name: "Konstantin Oberhauser-Wettstein",
    role: "admin",
    groups: [G.board],
    last: 800,
    passkey: false,
    expired: true,
    mail: "first.last+billing-notifications@example.com",
  },
  {
    name: "Seán O'Brien-Ó Súilleabháin",
    role: "member",
    groups: [G.sales],
    last: 3,
    passkey: true,
    uid: "sean.obrien",
    mail: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
  },
];
const worstAccounts: AccountDirectoryEntry[] = [
  ...worstSeeds.map((seed, index) => person(seed, index, "44444444-4444-4444-8444-")),
  service(11, "agent", "Benachrichtigungseinstellungen-Synchronisierung für Lager und Versand", "active", 0),
  service(12, "api-key", "X", "disabled", null),
];
export const FIXTURE_WORST_ACCOUNTS: AccountDirectoryEntry[] = withSharedAddresses(worstAccounts);
/** The worst case in a Cloud of 1,284 accounts (break-ui "huge"): the list still holds one page of them. */
export const FIXTURE_HUGE_ACCOUNTS: AccountDirectoryEntry[] = withSharedAddresses([
  ...worstAccounts,
  ...Array.from({ length: 1284 - worstAccounts.length }, (_, index) => {
    const base = seeds[index % 14]!;
    if (index % 50 === 49)
      return service(1000 + index, index % 100 === 99 ? "api-key" : "agent", `Agent ${index + 1}`, "active", index % 30);
    return person(
      { ...base, name: `Aushilfe ${index + 1}`, uid: `aushilfe${index + 1}`, mail: `aushilfe${index + 1}@${DOMAIN}`, last: index % 200 },
      index,
      "55555555-5555-4555-8555-",
    );
  }),
]);

/** The sample a test opens (break-ui states): the demo, the worst case, the worst case among 1,284 accounts, or none. */
export const fixtureSample = (name: string | null | undefined): readonly AccountDirectoryEntry[] =>
  name === "worst" ? FIXTURE_WORST_ACCOUNTS : name === "huge" ? FIXTURE_HUGE_ACCOUNTS : name === "empty" ? [] : FIXTURE_ACCOUNTS;

/** The groups the lookup offers, with how many of the sample people are in each. */
export const fixtureGroupItems = (search: string): LookupItem[] =>
  Object.values(G)
    .filter((entry) => entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    .map((entry) => ({ value: entry.id, label: entry.name }));

const nameOf = (entry: AccountDirectoryEntry) =>
  (entry.kind === "person" ? entry.displayName || entry.mail || entry.uid : entry.name).toLowerCase();
const timeOf = (entry: AccountDirectoryEntry) => {
  const at = entry.kind === "person" ? entry.lastLogin : entry.lastUsed;
  return at ? Date.parse(at) : null;
};
const mailOf = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? entry.mail?.trim().toLowerCase() || null : null);
const SERVICE_STATUSES = ["active", "disabled"];
const PERSON_STATUSES = ["active", "invited", "expired"];

/**
 * What the server answers for a list state, over a sample: the same filters and sort as the account directory query.
 * The test stands in for the server with it, so the page and the API answer alike.
 */
export const fixtureDirectory = (
  state: UsersState,
  sample: readonly AccountDirectoryEntry[] = FIXTURE_ACCOUNTS,
): AccountDirectoryEntry[] => {
  const query = directoryQueryOf(state, FIXTURE_TIME_ZONE, new Date(FIXTURE_NOW));
  const search = query.search?.toLowerCase();
  // the filters only a person has narrow the list to people, as the service does
  const personOnly = [query.roles, query.groupIds, query.lastLogin, query.passkey, query.provider, query.duplicateMail].some(
    (part) => part !== undefined,
  );
  const rows = sample.filter((entry) => {
    if (query.kinds && !query.kinds.includes(entry.kind)) return false;
    if (query.statuses && !query.statuses.includes(entry.status)) return false;
    if (entry.kind !== "person") {
      if (personOnly) return false;
      if (query.statuses && !query.statuses.some((status) => SERVICE_STATUSES.includes(status))) return false;
      return !search || entry.name.toLowerCase().includes(search);
    }
    if (query.statuses && !query.statuses.some((status) => PERSON_STATUSES.includes(status))) return false;
    if (search && !`${entry.displayName} ${entry.mail} ${entry.uid}`.toLowerCase().includes(search)) return false;
    if (query.roles && !query.roles.includes(entry.role)) return false;
    if (query.groupIds && !entry.groups.some((own) => query.groupIds?.includes(own.id))) return false;
    if (query.passkey !== undefined && entry.passkey !== query.passkey) return false;
    if (query.provider && entry.provider !== query.provider) return false;
    if (query.duplicateMail !== undefined && entry.duplicateMail !== query.duplicateMail) return false;
    if (query.lastLogin === "never" && entry.lastLogin !== null) return false;
    if (query.lastLogin && query.lastLogin !== "never") {
      const at = entry.lastLogin ? Date.parse(entry.lastLogin) : null;
      if (at === null) return false;
      if (query.lastLogin.since && at < query.lastLogin.since.getTime()) return false;
      if (query.lastLogin.until && at >= query.lastLogin.until.getTime()) return false;
    }
    return true;
  });
  const sign = query.sort.direction === "asc" ? 1 : -1;
  return rows.sort((a, b) => {
    if (query.sort.field === "name") return sign * nameOf(a).localeCompare(nameOf(b), "de");
    if (query.sort.field === "mail") {
      const [x, y] = [mailOf(a), mailOf(b)];
      if (x === y) return sign * nameOf(a).localeCompare(nameOf(b), "de");
      if (x === null) return 1;
      if (y === null) return -1;
      return sign * x.localeCompare(y);
    }
    const [x, y] = [timeOf(a), timeOf(b)];
    // "never" counts as the oldest
    return sign * ((x ?? 0) - (y ?? 0));
  });
};
