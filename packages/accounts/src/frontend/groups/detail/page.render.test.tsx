import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaseGroup, CloudRuntime, GroupRelations, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, audit, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { Hono } from "hono";
import type { EntityListItem } from "@/contracts";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-group-detail-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const admin = {
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
const person = {
  ...admin,
  id: "11111111-1111-4111-8111-000000000002",
  uid: "pia",
  roles: ["user"],
  displayName: "Pia Person",
} satisfies User;

const groupId = "22222222-2222-4222-8222-222222222222";
const finance: BaseGroup = { id: groupId, name: "finance", provider: "local", description: null, gidnumber: null, personalOwner: null };
const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };
const ada: EntityListItem = {
  kind: "user",
  user: { ...admin, id: "11111111-1111-4111-8111-0000000000ad", uid: "ada", displayName: "Ada Renz" },
};
const memberGroup = (index: number): EntityListItem => ({
  kind: "group",
  group: {
    id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    name: `team-${index}`,
    provider: "local",
    description: null,
    gidnumber: null,
    personalOwner: null,
  },
  relation: { direct: true },
});

const all = "00000000-0000-4000-8000-000000000001";
const relationsAround: GroupRelations = {
  focus: groupId,
  depth: 2,
  managers: false,
  groupCount: 2,
  nodes: [
    { id: all, name: "All staff", provider: "local", members: 3, contains: 1, inCycle: false },
    { id: groupId, name: "finance", provider: "local", members: 4, contains: 0, inCycle: false },
  ],
  columns: [{ key: "u1", items: [{ id: all, via: groupId }], backs: [], hidden: 0 }],
  roots: null,
  selected: {
    id: groupId,
    parents: { ids: [all], total: 1 },
    children: { ids: [], total: 0 },
    manages: null,
    managedBy: null,
    cycle: null,
    managerCycle: null,
  },
  cycles: { count: 0, first: null },
  truncated: false,
  cyclesComplete: true,
  managerCyclesComplete: true,
};

/** The HTML of a page body: how many elements it has and how many loading marks (none on the first picture). */
const weigh = (html: string) => {
  const body = html.slice(html.indexOf("<body"));
  return { elements: (body.match(/<[a-zA-Z][^>]*>/g) ?? []).length, loaders: (body.match(/k2-skel|aria-busy="true"/g) ?? []).length };
};

/** Serves the detail page; the entities answer `entities` for the page asked for, with `total` entries in all. */
const withGroup = async (
  options: {
    viewer?: User;
    group?: BaseGroup;
    total: number;
    entities?: (page: number, perPage: number) => EntityListItem[];
    relations?: () => ReturnType<typeof accountsAppService.group.relations>;
    /** The group's audit events, newest first. */
    audit?: Awaited<ReturnType<typeof audit.list>>["items"];
    /** The group's direct members by kind. */
    direct?: { type: "user" | "group" | "service_account"; id: string }[];
    /** Who manages the group directly. */
    managers?: { type: "user" | "group" | "service_account"; id: string }[];
  },
  run: (
    app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>,
    calls: { pages: number[]; entity: unknown[]; relations: unknown[]; audit: number; names: unknown[] },
  ) => Promise<void>,
) => {
  const calls = {
    pages: [] as number[],
    entity: [] as unknown[],
    relations: [] as unknown[],
    managers: 0,
    audit: 0,
    names: [] as unknown[],
  };
  const viewer = options.viewer ?? admin;
  const spies = [
    stubRailSnapshot(),
    spyOn(coreSettings, "get").mockResolvedValue(false),
    spyOn(linuxIdentities, "configuration").mockResolvedValue({
      enabled: false,
      rangeStart: 10000,
      rangeEnd: 20000,
      homeTemplate: "/home/{uid}",
      loginShell: "/bin/bash",
    }),
    spyOn(accountsAppService.group, "get").mockResolvedValue(options.group ?? finance),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
    spyOn(accountsAppService.group.parent, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.managedGroup, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.member, "list").mockResolvedValue({ ...empty, items: options.direct ?? [] } as never),
    spyOn(audit, "list").mockImplementation(async () => {
      calls.audit += 1;
      return { items: options.audit ?? [], page: 1, perPage: 10, total: options.audit?.length ?? 0, hasNext: false };
    }),
    spyOn(accountsAppService.group.manager, "list").mockResolvedValue({ ...empty, items: options.managers ?? [] } as never),
    // Like the service: a page past the end is empty, but the total still counts every entry.
    spyOn(accountsAppService.group, "relations").mockImplementation(async (input) => {
      calls.relations.push(input);
      return options.relations ? options.relations() : { ok: true, data: relationsAround };
    }),
    spyOn(accountsAppService.entity, "list").mockImplementation(async (input) => {
      // the names of the managers' faces and of the activity are one read of their own
      if (input.userIds || input.groupIds || input.serviceAccountIds) {
        calls.names.push(input);
        return { items: [ada, memberGroup(7)], page: 1, perPage: 10, total: 2, hasNext: false };
      }
      calls.entity.push(input);
      const page = input.pagination?.page ?? 1;
      const perPage = input.pagination?.perPage ?? 100;
      calls.pages.push(page);
      const items =
        options.entities?.(page, perPage) ??
        Array.from({ length: Math.max(0, Math.min(perPage, options.total - (page - 1) * perPage)) }, (_, offset) =>
          memberGroup((page - 1) * perPage + offset + 1),
        );
      return { items, page, perPage, total: options.total, hasNext: page * perPage < options.total };
    }),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: viewer });
    c.set("user", viewer);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/groups/:id", ...handler);
  try {
    await run(app, calls);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

const open = (app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>, query: string, language = "en") =>
  app.request(`/app/accounts/groups/${groupId}${query}`, { headers: { "Accept-Language": language } });

test("the tabs are links that keep the list context and clear the tab's own search, page and display", async () => {
  await withGroup({ total: 1000 }, async (app) => {
    for (const current of ["members", "managers", "member-of"]) {
      const response = await open(app, `?tab=${current}&search=ada&page=3&indirect=true&service_accounts=true&list_search=ops&list_page=2`);
      const html = await response.text();
      expect(response.status, html).toBe(200);
      const nav = html.match(/<nav[^>]*data-k2-part="Tabs"[^>]*>[\s\S]*?<\/nav>/)?.[0];
      expect(nav).toContain('aria-label="Group detail sections"');
      const links = [...nav!.matchAll(/<a\b([^>]*)>/g)];
      expect(links).toHaveLength(4);
      for (const [index, tab] of ["members", "managers", "member-of", "relations"].entries()) {
        const attrs = links[index]![1]!;
        expect(attrs).toContain(`href="/app/accounts/groups/${groupId}?list_search=ops&amp;list_page=2&amp;tab=${tab}"`);
        expect(attrs.includes('aria-current="page"')).toBe(tab === current);
      }
    }
  });
});

test("the members tab reads the search, the indirect members and the agents from the address", async () => {
  await withGroup({ total: 3 }, async (app, calls) => {
    await open(app, "?search=ada&indirect=true&service_accounts=true");
    expect(calls.entity[0]).toMatchObject({
      search: "ada",
      memberOfGroupId: groupId,
      recursive: true,
      kinds: ["user", "group", "service_account"],
    });
    await open(app, "?tab=managers&indirect=true");
    expect(calls.entity[1]).toMatchObject({ managerOfGroupId: groupId, kinds: ["user", "group"] });
    expect(calls.entity[1]).not.toHaveProperty("recursive");
    // nobody to name: no read besides the tab's own
    expect(calls.names).toEqual([]);
  });
});

test("a members page past the end opens the last page with the same filters instead of an empty group", async () => {
  await withGroup({ total: 150 }, async (app) => {
    const response = await open(app, "?list_page=2&list_scope=all&tab=members&indirect=true&page=7");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/app/accounts/groups/${groupId}?list_page=2&list_scope=all&tab=members&indirect=true&page=2`,
    );
  });
  await withGroup({ total: 3 }, async (app) => {
    // With one page left, the URL names no page at all.
    const response = await open(app, "?list_scope=all&page=2");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/app/accounts/groups/${groupId}?list_scope=all`);
  });
});

test("the last page itself and an empty group answer without a redirect, with no loading mark", async () => {
  await withGroup({ total: 150 }, async (app) => {
    const response = await open(app, "?page=2");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(">team-101<");
    expect(html).toContain(">team-150<");
    expect(html).toContain("Page 2 of 2");
    expect(html).not.toContain("This group has no members.");
    expect(weigh(html).loaders).toBe(0);
  });
  await withGroup({ total: 0 }, async (app) => {
    const html = await (await open(app, "")).text();
    expect(html).toContain("This group has no members.");
    expect(weigh(html).loaders).toBe(0);
  });
});

test("opening a group from page 2 of the list shows its first members and leads back to that list", async () => {
  await withGroup({ total: 3 }, async (app, calls) => {
    // The list's paging and scope stay list context: they lead back to the list but do not page the members.
    const response = await open(app, "?list_search=fin&list_page=2&list_scope=managed");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(calls.pages).toEqual([1]);
    for (const name of ["team-1", "team-2", "team-3"]) expect(html).toContain(`>${name}<`);
    expect(html).toContain('href="/app/accounts/groups?q=fin&amp;page=2&amp;scope=managed"');
  });
});

for (const [language, shown] of [
  ["de", "Presse-Team"],
  ["en", "presse-team"],
] as const)
  test(`${language}: a parent group shows its display name and links by ID`, async () => {
    const parent: EntityListItem = {
      kind: "group",
      group: {
        id: "33333333-3333-4333-8333-0000000000aa",
        provider: "local",
        name: "presse-team",
        description: null,
        gidnumber: null,
        personalOwner: null,
      },
      relation: { direct: true },
    };
    await withGroup({ total: 1, entities: () => [parent] }, async (app) => {
      const html = await (await open(app, "?tab=member-of", language)).text();
      // the row opens the group by its ID and is named by its title, which shows the display name
      const label = html.match(/aria-labelledby="([^"]+)" href="\/app\/accounts\/groups\/33333333-3333-4333-8333-0000000000aa"/)?.[1];
      expect(label).toBeDefined();
      expect(html).toContain(`id="${label}">${shown}<`);
    });
  });

test("a personal Linux group names its user, explains why it stays, and links administrators to the user", async () => {
  const personal: BaseGroup = {
    ...finance,
    name: "qdt",
    gidnumber: 10001,
    personalOwner: { id: person.id, uid: "qdt", displayName: "Quinn Doe" },
  };
  for (const language of ["en", "de"] as const) {
    await withGroup({ group: personal, total: 0 }, async (app) => {
      const html = await (await open(app, "", language)).text();
      // the head says the group is personal; the facts say whose it is
      expect(html).toMatch(language === "en" ? />Personal</ : />Persönlich</);
      expect(html).toMatch(language === "en" ? />Belongs to</ : />Gehört zu</);
      expect(html).toContain(
        language === "en"
          ? "This is Quinn Doe's personal Linux group. It can't be deleted while it is their primary group."
          : "Das ist die persönliche Linux-Gruppe von Quinn Doe. Sie kann nicht gelöscht werden, solange sie deren primäre Gruppe ist.",
      );
      expect(html).toContain(`href="/app/accounts/users/${person.id}"`);
    });
  }
  // Someone who cannot open user details reads the owner's name only, and no explanation of a deed they cannot take.
  await withGroup({ viewer: person, group: personal, total: 0 }, async (app) => {
    const html = await (await open(app, "")).text();
    expect(html).toMatch(/>Personal</);
    expect(html).toContain(">Quinn Doe<");
    expect(html).not.toContain(`href="/app/accounts/users/${person.id}"`);
    expect(html).not.toContain("be deleted while");
  });
});

test("the first picture is lighter than the v1 page and has no loading mark", async () => {
  await withGroup({ total: 5 }, async (app) => {
    const html = await (await open(app, "")).text();
    const { elements, loaders } = weigh(html);
    // The v1 page rendered 565 elements for five members (measured 25.11.2026); v2 must not grow past it.
    expect(elements).toBeLessThan(565);
    expect(loaders).toBe(0);
  });
});

test("the relations view draws the levels around the group and keeps its state and the list context in every link", async () => {
  await withGroup({ total: 0 }, async (app, calls) => {
    const response = await open(app, "?tab=relations&depth=3&managers=1&list_search=ops&sel=" + all + "&expand=u1,x2");
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(calls.relations[0]).toMatchObject({ focus: groupId, selected: all, depth: 3, managers: true, view: "graph", expand: ["u1"] });
    // the relations tab reads no members
    expect(calls.entity).toEqual([]);
    expect(html).toContain("Contained in · level 1");
    expect(html).toContain("2 groups · No cycles");
    expect(html).toContain(
      `href="/app/accounts/groups/${groupId}?list_search=ops&amp;tab=relations&amp;sel=${all}&amp;depth=3&amp;managers=1&amp;expand=u1"`,
    );
    expect(weigh(html).loaders).toBe(0);
  });
});

test("a group without relations to show and a failed read each say so in place; others see no relations tab", async () => {
  await withGroup(
    { total: 0, relations: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Group not found", status: 404 } }) },
    async (app) => {
      const html = await (await open(app, "?tab=relations")).text();
      expect(html).toContain("This group has no relations.");
    },
  );
  await withGroup(
    {
      total: 0,
      relations: async () => {
        throw new Error("database unavailable");
      },
    },
    async (app) => {
      const html = await (await open(app, "?tab=relations")).text();
      expect(html).toContain("Could not load relations");
      expect(html).toContain('data-k2-part="Failed"');
    },
  );
  await withGroup({ viewer: person, total: 0 }, async (app, calls) => {
    const html = await (await open(app, "?tab=relations")).text();
    expect(calls.relations).toEqual([]);
    expect(html.match(/<nav[^>]*data-k2-part="Tabs"[^>]*>[\s\S]*?<\/nav>/)?.[0]).not.toContain("tab=relations");
    expect(html).toContain("This group has no members.");
  });
});

const event = (id: number, action: string, target: string, metadata: Record<string, unknown> = {}) => ({
  id,
  createdAt: "2026-11-25T09:42:00.000Z",
  action,
  outcome: "allowed" as const,
  actor: { userId: ada.kind === "user" ? ada.user.id : null, uid: "ada", provider: "local", roles: ["admin"] },
  target: { type: "group", id: target, label: "finance", provider: "local" },
  reason: null,
  errorCode: null,
  errorMessage: null,
  requestId: null,
  metadata,
});

test("the first row counts the direct members by kind, the managers with their faces, the sub-groups and the parents", async () => {
  const direct = [
    { type: "user" as const, id: "u1" },
    { type: "user" as const, id: "u2" },
    { type: "service_account" as const, id: "a1" },
    { type: "group" as const, id: "g1" },
  ];
  const managers = [
    { type: "user" as const, id: ada.kind === "user" ? ada.user.id : "" },
    { type: "group" as const, id: "33333333-3333-4333-8333-000000000007" },
    { type: "user" as const, id: "11111111-1111-4111-8111-0000000000ff" },
  ];
  await withGroup({ total: 3, direct, managers }, async (app, calls) => {
    const html = await (await open(app, "")).text();
    expect(html).toContain('data-k2-part="Cells"');
    expect(html).toContain("2 people · 1 agent");
    expect(html).toContain(">Sub-groups<");
    // three managers; the ones the directory names show their faces, read once for all of them
    expect(html).toMatch(/data-k2-part="Avatar.Stack"[^>]*aria-label="Ada Renz, team-7"/);
    expect(calls.names).toHaveLength(1);
  });
  // the managers tab names its managers from its own rows: no further read
  await withGroup({ total: 3, managers: [managers[1]!], entities: () => [memberGroup(7)] }, async (app, calls) => {
    await open(app, "?tab=managers");
    expect(calls.names).toEqual([]);
  });
});

test("administrators read the group's last changes as sentences; others never read the audit log", async () => {
  const adaId = ada.kind === "user" ? ada.user.id : "";
  const audited = [
    event(3, "accounts.group.member.add", groupId, { userId: adaId }),
    event(2, "accounts.group.member.add", "33333333-3333-4333-8333-000000000099", { userId: adaId }),
    event(1, "accounts.group.update", groupId),
  ];
  await withGroup({ total: 3, audit: audited }, async (app, calls) => {
    const html = await (await open(app, "")).text();
    expect(html).toContain(">Activity<");
    expect(html).toContain("changed the description");
    // the actor in bold, the verb, and whom it concerned
    expect(html.replace(/<!--[^>]*-->/g, "")).toMatch(/>Ada Renz<\/span> added <span[^>]*>Ada Renz</);
    // the event of another group with a similar name stays out
    expect(html.match(/changed the description|added /g)?.length).toBe(2);
    expect(calls.audit).toBe(1);
    expect(calls.names).toHaveLength(1);
    expect(calls.names[0]).toMatchObject({ userIds: [adaId] });
  });
  await withGroup({ viewer: person, total: 3, audit: audited }, async (app, calls) => {
    const html = await (await open(app, "")).text();
    expect(calls.audit).toBe(0);
    expect(html).not.toContain(">Activity<");
  });
});
