import type { UserDirectoryEntry } from "@k2b/cloud/contracts";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { directoryQueryOf, type UsersState } from "./query";

// Invented sample data for the user list's browser test and design review: a fixed "now", fixed IDs, no real people.

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

type Seed = [name: string, role: UserDirectoryEntry["role"], groups: { id: string; name: string }[], last: number | null, passkey: boolean];
const seeds: Seed[] = [
  ["Hannah Stoll", "member", [G.office], 18, false],
  ["Jonas Hartwig", "member", [G.office], 37, true],
  ["Lina Vogt", "member", [G.office], 5, false],
  ["Milan Horvat", "admin", [G.board, G.sales], 42, false],
  ["Ada Renz", "admin", [G.store], 11, true],
  ["Karl Bergmann", "member", [G.store], 41, false],
  ["Vera Haas", "admin", [G.temps], 27, false],
  ["Mira Solberg", "admin", [G.board], 0, true],
  ["Petra Lindqvist", "member", [G.workshop, G.sales], 2, true],
  ["Felix Thom", "guest", [], null, false],
  ["Jana Kramer", "member", [G.workshop], null, false],
  ["Henrik Brandt", "admin", [G.workshop], 140, false],
  ["Lea Oswald", "guest", [G.temps], 3, false],
  ["Tobias Rombach", "member", [G.sales], 96, true],
];

export const FIXTURE_PEOPLE: UserDirectoryEntry[] = seeds.map(([name, role, groups, last, passkey], index) => {
  const [given = "", family = ""] = name.split(" ");
  const uid = `${given[0]!.toLowerCase()}.${family.toLowerCase()}`;
  const expired = name === "Henrik Brandt";
  return {
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    uid,
    roles: role === "admin" ? ["user", "admin"] : role === "guest" ? ["guest"] : ["user"],
    provider: index % 4 === 3 ? "ipa" : "local",
    profile: role === "guest" ? "guest" : "user",
    givenname: given,
    sn: family,
    displayName: name,
    mail: `${uid}@solberg-kramer.example`,
    avatarHash: null,
    role,
    status: expired ? "expired" : last === null ? "invited" : "active",
    lastLogin: last === null ? null : daysAgo(last),
    accountExpires: expired ? daysAgo(10) : null,
    passkey,
    groups: [...groups].sort((a, b) => a.name.localeCompare(b.name, "de")),
    groupCount: groups.length,
  };
});

/** The groups the lookup offers, with how many of the sample people are in each. */
export const fixtureGroupItems = (search: string): LookupItem[] =>
  Object.values(G)
    .filter((entry) => entry.name.toLowerCase().includes(search.trim().toLowerCase()))
    .map((entry) => ({ value: entry.id, label: entry.name }));

/**
 * What the server answers for a list state, over the sample people: the same filters and sort as the directory query.
 * The test stands in for the server with it, so the page and the API answer alike.
 */
export const fixtureDirectory = (state: UsersState, people: readonly UserDirectoryEntry[] = FIXTURE_PEOPLE): UserDirectoryEntry[] => {
  const query = directoryQueryOf(state, FIXTURE_TIME_ZONE, new Date(FIXTURE_NOW));
  const search = query.search?.toLowerCase();
  const rows = people.filter((person) => {
    if (search && !`${person.displayName} ${person.mail} ${person.uid}`.toLowerCase().includes(search)) return false;
    if (query.roles && !query.roles.includes(person.role)) return false;
    if (query.statuses && !query.statuses.includes(person.status)) return false;
    if (query.groupIds && !person.groups.some((own) => query.groupIds?.includes(own.id))) return false;
    if (query.passkey !== undefined && person.passkey !== query.passkey) return false;
    if (query.provider && person.provider !== query.provider) return false;
    if (query.lastLogin === "never" && person.lastLogin !== null) return false;
    if (query.lastLogin && query.lastLogin !== "never") {
      const at = person.lastLogin ? Date.parse(person.lastLogin) : null;
      if (at === null) return false;
      if (query.lastLogin.since && at < query.lastLogin.since.getTime()) return false;
      if (query.lastLogin.until && at >= query.lastLogin.until.getTime()) return false;
    }
    return true;
  });
  const sign = query.sort.direction === "asc" ? 1 : -1;
  return rows.sort((a, b) =>
    query.sort.field === "name"
      ? sign * a.displayName.localeCompare(b.displayName, "de")
      : sign * ((a.lastLogin ? Date.parse(a.lastLogin) : 0) - (b.lastLogin ? Date.parse(b.lastLogin) : 0)),
  );
};

/**
 * The realistic worst case of the user and group lists (break-ui): names at their limits (given name and family name
 * 120 characters each, display name 160), an address without a break, one-letter and missing names, a picture that
 * does not load, every role and status, an account in twelve groups, a group name of 120 characters without a space
 * (group names are slugs), a long description, and the counts 1 and 1,284.
 */
const worstGroup = (index: number, name: string) => ({ id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, name });
export const WORST_GROUPS = [
  worstGroup(1, "verkauf-und-ankauf-laden-online-auktionshaus-sonderveranstaltungen-wochenende-und-feiertage-region-ortenau-nord"),
  worstGroup(2, "j"),
  ...Array.from({ length: 10 }, (_, index) =>
    worstGroup(index + 3, ["Büro", "Verkauf", "Lager", "Geschäftsführung", "Aushilfen"][index % 5]! + ` ${index + 1}`),
  ),
];
export const WORST_GROUP_DESCRIPTION =
  "Alle, die am Wochenende und an Feiertagen im Laden, online und bei Sonderveranstaltungen ankaufen oder verkaufen; Ansprechpartnerin ist Frau Đặng Thị Ngọc Hân, erreichbar unter bartholomew.fitzgerald@northwind-industries-holdings.example.com. ".repeat(
    8,
  );

type WorstSeed = Partial<UserDirectoryEntry> & { displayName: string };
const worstSeeds: WorstSeed[] = [
  {
    displayName: "Christopher Alexander Montgomery III von Oberhauser-Wettstein zu Hohenlohe-Langenburg und Waldenburg-Schillingsfürst",
    givenname: "Christopher Alexander",
    sn: "Montgomery III",
    mail: "bartholomew.fitzgerald@northwind-industries-holdings.example.com",
    role: "admin",
    groups: WORST_GROUPS,
    groupCount: 12,
    lastLogin: "2026-11-25T11:59:59.000Z",
    passkey: true,
  },
  {
    displayName: "J",
    givenname: "J",
    sn: "J",
    mail: "a@b.test",
    role: "guest",
    status: "invited",
    lastLogin: null,
    groups: [WORST_GROUPS[1]!],
    groupCount: 1,
  },
  {
    displayName: "",
    givenname: "",
    sn: "",
    mail: null,
    uid: "x9f8e7d6c5b4a4c3d8e2f1a0b9c8d7e6f",
    role: "member",
    lastLogin: "2023-01-01T00:00:00.000Z",
  },
  {
    displayName: "Aleksandra Wiśniewska-Kowalczyk",
    avatarHash: "missing-picture",
    status: "expired",
    accountExpires: "2026-11-24T23:00:00.000Z",
  },
  { displayName: "🦊 Fox", mail: "first.last+billing-notifications@example.com", lastLogin: "2026-11-26T08:00:00.000Z" },
  { displayName: "Đặng Thị Ngọc Hân", groups: WORST_GROUPS.slice(2, 5), groupCount: 3 },
  { displayName: "王秀英", role: "admin" },
  { displayName: "<script>alert(1)</script> &amp; **fett**" },
];

export const WORST_PEOPLE: UserDirectoryEntry[] = [
  ...worstSeeds,
  ...Array.from({ length: 1284 - worstSeeds.length }, (_, index): WorstSeed => ({ displayName: `Aushilfe ${index + 1}` })),
].map((seed, index) => {
  const base = FIXTURE_PEOPLE[index % FIXTURE_PEOPLE.length]!;
  return {
    ...base,
    groups: [],
    groupCount: 0,
    ...seed,
    id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`,
    uid: seed.uid ?? `worst.${index + 1}`,
  };
});
