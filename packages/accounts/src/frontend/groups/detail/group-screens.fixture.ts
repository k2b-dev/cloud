import type { GroupRelations } from "@k2b/cloud/contracts";
import { parseRelationsUrl } from "../relations/relations-view";
import type { GroupMember, GroupScreenProps, GroupTab, GroupView } from "./GroupScreen";

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
    managedGroups: 0,
  },
  members: [
    user(1, "Milan Horvat"),
    user(2, "Ada Renz"),
    user(3, "Jana Berger", "guest"),
    group(PLATFORM, "Platform", "Plattform-Team"),
    agent(AGENT, "Nightly helper"),
    user(4, "Ole Brandt", "user", false),
  ],
  managers: [user(2, "Ada Renz"), agent(AGENT, "Nightly helper")],
  parents: [group(ALL, "All staff", "Alle Beschäftigten")],
  viewer: { isAdmin: true, canManage: true, canMutate: true, linuxEnabled: true },
  relations: graph,
});

/** The worst case of break-ui: very long names, an unbreakable address, a guest, many members over two pages. */
export const worstDb = (): GroupDb => {
  const db = sampleDb();
  db.group = {
    ...db.group,
    name: "Interdisziplinäre-Arbeitsgemeinschaft-für-Qualitätssicherung-und-Prozessdokumentation-Standort-Nord",
    gid: 1_999_999_999,
    description: "x".repeat(400),
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
  return {
    group: db.group,
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
            data: db.relations === graph && query("view") === "list" ? tree : db.relations,
            context: "",
          }
        : undefined,
  };
};
