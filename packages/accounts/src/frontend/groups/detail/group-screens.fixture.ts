import type { GroupRelations } from "@k2b/cloud/contracts";
import type { GroupListEntry } from "../GroupsScreen";
import { parseRelationsUrl } from "../relations/relations-view";
import type { GroupActivity, GroupMember, GroupScreenProps, GroupTab, GroupView } from "./GroupScreen";

// Invented, frozen data for the group record's browser test: the test keeps a `GroupDb` as its server and answers each
// page with the props `propsFor` builds from the address, as `page.tsx` builds them from the services.

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const GROUP = id(2);
export const [ALL, PLATFORM, ONCALL, SALES] = [id(1), id(3), id(4), id(5)] as [string, string, string, string];
export const AGENT = "11111111-1111-4111-8111-111111111111";
export const NEW_AGENT = "22222222-2222-4222-8222-222222222222";

const user = (n: number, name: string, profile: "user" | "guest" = "user", direct = true): GroupMember => {
  const uid = name.toLowerCase().replaceAll(" ", ".");
  const userId = `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
  return {
    key: `user:${userId}`,
    kind: "user",
    id: userId,
    name,
    line: `${uid} · ${uid}@solberg-kramer.example`,
    profile,
    direct,
    href: `/app/accounts/users/${userId}`,
  };
};
export const agent = (agentId: string, name: string): GroupMember => ({
  key: `service_account:${agentId}`,
  kind: "agent",
  id: agentId,
  name,
  line: null,
  direct: true,
  href: `/app/accounts/users/${agentId}`,
  image: `/api/accounts/users/${agentId}/avatar`,
});
const group = (groupId: string, name: string, description: string | null, direct = true): GroupMember => ({
  key: `group:${groupId}`,
  kind: "group",
  id: groupId,
  name,
  line: description,
  provider: "local",
  direct,
  href: `/app/accounts/groups/${groupId}`,
});

const node = (nodeId: string, name: string, extra: Partial<GroupRelations["nodes"][number]> = {}) => ({
  id: nodeId,
  name,
  provider: "local" as const,
  members: 3,
  contains: 1,
  inCycle: false,
  ...extra,
});
const list = (entries: string[]) => ({ ids: entries, total: entries.length });
/** The relations around Engineering at depth 2: a cycle Engineering → Platform → On call → Engineering inside All staff. */
export const graph: GroupRelations = {
  focus: GROUP,
  depth: 2,
  managers: false,
  groupCount: 5,
  nodes: [
    node(ALL, "All staff", { contains: 2 }),
    node(GROUP, "Engineering", { provider: "ipa", inCycle: true }),
    node(PLATFORM, "Platform", { provider: "ipa", inCycle: true }),
    node(ONCALL, "On call", { provider: "ipa", inCycle: true }),
    node(SALES, "Sales", { contains: 0 }),
  ],
  columns: [
    { key: "u1", items: [{ id: ALL, via: GROUP }], backs: [{ from: GROUP, to: ONCALL, closesCycle: true }], hidden: 0 },
    { key: "d1", items: [{ id: PLATFORM, via: GROUP }], backs: [], hidden: 3 },
    { key: "d2", items: [{ id: ONCALL, via: PLATFORM }], backs: [], hidden: 0 },
  ],
  roots: null,
  selected: {
    id: GROUP,
    parents: list([ALL, ONCALL]),
    children: list([PLATFORM]),
    manages: null,
    managedBy: null,
    cycle: { path: [GROUP, PLATFORM, ONCALL, GROUP], size: 3 },
    managerCycle: null,
  },
  cycles: { count: 1, first: GROUP },
  truncated: false,
  cyclesComplete: true,
  managerCyclesComplete: true,
};
export const tree: GroupRelations = { ...graph, columns: [], roots: { ids: [ALL], hidden: 1 } };
/** What each group contains, for the tree's levels. */
export const children: Record<string, string[]> = { [ALL]: [SALES, GROUP], [GROUP]: [PLATFORM], [PLATFORM]: [ONCALL], [ONCALL]: [GROUP] };

/** The server's state for one test: the group, who stands in it, and who looks at it. */
export type GroupDb = {
  group: GroupView;
  members: GroupMember[];
  managers: GroupMember[];
  parents: GroupMember[];
  viewer: { isAdmin: boolean; canManage: boolean; canMutate: boolean; linuxEnabled: boolean };
  relations: GroupRelations | "none" | null;
  activity: GroupActivity[];
};

export const sampleDb = (): GroupDb => ({
  group: {
    id: GROUP,
    name: "Engineering",
    storedName: "engineering",
    provider: "local",
    gid: null,
    description: "Entwicklung, Betrieb und Bereitschaft",
    owner: null,
    parents: 1,
    managedGroups: 2,
    // counted by `propsFor` from the members, as the server counts them
    people: 0,
    agents: 0,
    subGroups: 0,
    managers: { total: 0, faces: [] },
  },
  members: [
    user(1, "Milan Horvat"),
    user(2, "Ada Renz"),
    user(3, "Jana Berger", "guest"),
    group(PLATFORM, "Platform", "Plattform-Team: Kubernetes, Datenbanken, Netz"),
    group(ONCALL, "On call", "Bereitschaft am Wochenende"),
    agent(AGENT, "Nightly helper"),
    user(5, "Felix Thal"),
    user(6, "Lena Hartwig"),
    user(7, "Sami Yilmaz"),
    user(8, "Mira Solberg"),
    user(9, "Tom Oswald", "guest"),
    user(10, "Jonas Kern"),
    user(11, "Petra Lindqvist"),
    user(12, "Karim Haddad"),
    user(13, "Nele Brückner"),
    user(14, "Ida Sørensen"),
    user(4, "Ole Brandt", "user", false),
  ],
  managers: [user(2, "Ada Renz"), user(1, "Milan Horvat"), user(8, "Mira Solberg"), agent(AGENT, "Nightly helper")],
  parents: [group(ALL, "All staff", "Alle Beschäftigten")],
  viewer: { isAdmin: true, canManage: true, canMutate: true, linuxEnabled: true },
  relations: graph,
  activity: [
    { id: "5", action: "member.add", actor: { name: "Ada Renz" }, subject: { kind: "user", name: "Ida Sørensen" }, time: "vor 12 Min." },
    { id: "4", action: "manager.add", actor: { name: "Ada Renz" }, subject: { kind: "user", name: "Mira Solberg" }, time: "vor 2 Std." },
    { id: "3", action: "member.add", actor: { name: "Milan Horvat" }, subject: { kind: "group", name: "On call" }, time: "gestern, 16:40" },
    {
      id: "2",
      action: "member.remove",
      actor: { name: "Milan Horvat" },
      subject: { kind: "user", name: "Paul Weber" },
      time: "Mo., 09:12",
    },
    { id: "1", action: "update", actor: { name: "Ada Renz" }, subject: null, time: "12. Nov." },
  ],
});

/** The worst case of break-ui: very long names, an unbreakable address, a guest, many members over two pages. */
export const worstDb = (): GroupDb => {
  const db = sampleDb();
  db.group = {
    ...db.group,
    name: "Interdisziplinäre-Arbeitsgemeinschaft-für-Qualitätssicherung-und-Prozessdokumentation-Standort-Nord",
    gid: 1_999_999_999,
    description:
      "Koordiniert die Qualitätssicherung, die Prozessdokumentation und die Audits aller Standorte im Norden; zuständig für Vorlagen, Prüfpläne, Schulungen und die jährliche Zertifizierung nach ISO 9001 sowie für Rückfragen der Auditoren.",
    owner: { id: id(77), name: "Maximiliane Theodora von Hohenzollern-Sigmaringen" },
  };
  db.members = Array.from({ length: 120 }, (_, index) =>
    index === 0
      ? {
          ...user(900, "Prof. Dr. Maximiliane Theodora Wilhelmine von Hohenzollern-Sigmaringen", "guest"),
          line: "maximiliane.theodora.wilhelmine.von.hohenzollern-sigmaringen@sehr-lange-domain-ohne-umbruch.example",
        }
      : user(index + 1, `Person ${index + 1}`),
  );
  return db;
};

/** A huge group: 1,200 members, of which the page shows the server's first 100. */
export const hugeDb = (): GroupDb => {
  const db = sampleDb();
  db.members = Array.from({ length: 1200 }, (_, index) => user(index + 1, `Person ${index + 1}`));
  return db;
};

/** The relations the service answers: the tree for `view=list`, and the details of the chosen group (`sel`). */
const relationsFor = (db: GroupDb, url: URL): GroupDb["relations"] => {
  if (db.relations !== graph) return db.relations;
  const base = url.searchParams.get("view") === "list" ? tree : graph;
  const sel = url.searchParams.get("sel");
  return sel && base.selected ? { ...base, selected: { ...base.selected, id: sel, cycle: null } } : base;
};

/** The props `page.tsx` would pass for an address. */
export const propsFor = (db: GroupDb, url: URL): GroupScreenProps => {
  const query = (name: string) => url.searchParams.get(name) ?? "";
  const admin = db.viewer.isAdmin;
  const tabs: GroupTab[] = admin ? ["members", "managers", "member-of", "relations"] : ["members", "managers"];
  const asked = query("tab") as GroupTab;
  const tab: GroupTab = tabs.includes(asked) ? asked : "members";
  const search = query("search");
  const indirect = tab === "members" && query("indirect") === "true";
  const agents = tab !== "member-of" && query("service_accounts") === "true";
  const base = `/app/accounts/groups/${db.group.id}`;
  const href = (params: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) next.set(key, value);
    return `${base}?${next}`;
  };
  const display = { tab, search: search || null, indirect: indirect ? "true" : null, service_accounts: agents ? "true" : null };
  const all = tab === "members" ? db.members : tab === "managers" ? db.managers : tab === "member-of" ? db.parents : [];
  const shown = all
    .filter((entry) => indirect || entry.direct)
    .filter((entry) => agents || tab === "member-of" || entry.kind !== "agent")
    .filter((entry) => !search || entry.name.toLowerCase().includes(search.toLowerCase()));
  const pages = Math.max(1, Math.ceil(shown.length / 100));
  const page = Math.min(Math.max(1, Number(query("page")) || 1), pages);
  const ids = (kind: string) => all.filter((entry) => entry.direct && entry.key.startsWith(`${kind}:`)).map((entry) => entry.id);
  const direct = db.members.filter((entry) => entry.direct);
  return {
    group: {
      ...db.group,
      people: direct.filter((entry) => entry.kind === "user").length,
      agents: direct.filter((entry) => entry.kind === "agent").length,
      subGroups: direct.filter((entry) => entry.kind === "group").length,
      managers: { total: db.managers.length, faces: db.managers.slice(0, 4).map((entry) => ({ name: entry.name, image: entry.image })) },
    },
    activity: admin ? db.activity : [],
    tab,
    tabs: tabs.map((entry) => ({ tab: entry, href: href({ tab: entry }) })),
    rows: shown.slice((page - 1) * 100, page * 100),
    total: shown.length,
    search,
    indirect,
    agents,
    links: {
      search: href({ ...display, search: null }),
      clearSearch: href({ ...display, search: null }),
      indirect: href({ ...display, indirect: indirect ? null : "true" }),
      agents: href({ ...display, service_accounts: agents ? null : "true" }),
      previous: page > 1 ? href({ ...display, page: page === 2 ? null : String(page - 1) }) : null,
      next: page < pages ? href({ ...display, page: String(page + 1) }) : null,
      list: "/app/accounts/groups",
    },
    page,
    pages,
    exclude: {
      users: ids("user"),
      groups: tab === "member-of" ? db.parents.map((entry) => entry.id) : ids("group"),
      agents: ids("service_account"),
    },
    isAdmin: admin,
    canManage: db.viewer.canManage && db.viewer.canMutate,
    canMutate: db.viewer.canMutate,
    linuxEnabled: db.viewer.linuxEnabled,
    pendingRequests: 2,
    relations:
      tab === "relations"
        ? {
            state: { ...parseRelationsUrl((name) => url.searchParams.get(name) ?? undefined), focus: db.group.id },
            data: relationsFor(db, url),
            context: "",
          }
        : undefined,
  };
};

/** The group list of an administrator: dense, real names, managed in both places, POSIX and personal groups among them. */
export const groupList: GroupListEntry[] = (
  [
    ["Alle Beschäftigten", "Alle Konten mit Login, für Freigaben an alle", "local", true, false, false],
    ["Buchhaltung", "Rechnungen, Belege, Monatsabschluss", "ipa", true, true, false],
    ["Engineering", "Entwicklung, Betrieb und Bereitschaft", "local", true, true, false],
    ["Geschäftsführung", null, "ipa", false, false, false],
    ["Lager Nord", "Bestand, Einlieferungen, Inventur", "local", false, true, false],
    ["On call", "Bereitschaft am Wochenende", "ipa", true, false, false],
    ["Personal", "Urlaub, Schichten und Schulungen", "local", false, false, false],
    ["Platform", "Plattform-Team: Kubernetes, Datenbanken, Netz", "ipa", true, true, false],
    ["Presse-Team", "Mitteilungen und Anfragen der Presse", "local", false, false, false],
    ["qdt", "Persönliche Gruppe von Quinn Doe", "local", true, false, true],
    ["Vertrieb", "Angebote, Pipeline und Kundenbetreuung", "ipa", false, true, false],
    ["Werkstatt", "Aufträge, Ersatzteile und Termine", "local", true, false, false],
  ] as const
).map(([name, description, provider, posix, managed, personal], index) => ({
  id: id(100 + index),
  name,
  description,
  provider,
  posix,
  managed,
  personal,
  href: `/app/accounts/groups/${id(100 + index)}`,
}));
