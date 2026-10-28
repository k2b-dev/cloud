import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-group-detail-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
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

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/groups/:id", ...handler);
  return app;
};

const groupId = "22222222-2222-4222-8222-222222222222";
test("group sections are ViewTabs links, clearing tab filters and retaining list context", async () => {
  const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };
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
    spyOn(accountsAppService.group, "get").mockResolvedValue({
      id: groupId,
      name: "finance",
      provider: "local",
      description: null,
      gidnumber: null,
      personalOwner: null,
    }),
    spyOn(accountsAppService.accountRequest, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.parent, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.managedGroup, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.member, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.manager, "list").mockResolvedValue(empty),
    // Enough entries that page 3 exists; a page past the end redirects.
    spyOn(accountsAppService.entity, "list").mockResolvedValue({ ...empty, page: 3, total: 1000, hasNext: true }),
  ];
  try {
    const app = server();
    for (const current of ["members", "managers", "member-of"]) {
      const response = await app.request(
        `/app/accounts/groups/${groupId}?tab=${current}&search=ada&page=3&indirect=true&service_accounts=true&list_search=ops&list_page=2`,
        { headers: { "Accept-Language": "en" } },
      );
      const html = await response.text();
      expect(response.status, html).toBe(200);
      const nav = html.match(/<nav[^>]*class="k2b-view-tabs[^>]*>[\s\S]*?<\/nav>/)?.[0];
      expect(nav).toBeDefined();
      expect(nav).toContain('aria-label="Group detail sections"');
      expect(nav).not.toContain('role="tab"');
      expect(nav).not.toContain('data-variant="primary"');
      const links = [...nav!.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      expect(links).toHaveLength(3);
      for (const [index, tab] of ["members", "managers", "member-of"].entries()) {
        const attrs = links[index]![1]!;
        expect(attrs).toContain(`href="/app/accounts/groups/${groupId}?list_search=ops&amp;list_page=2&amp;tab=${tab}"`);
        expect(attrs.includes('aria-current="page"')).toBe(tab === current);
        for (const cleared of ["&amp;search=", "&amp;page=", "indirect=", "service_accounts="]) expect(attrs).not.toContain(cleared);
      }
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

const memberGroup = (index: number) => ({
  kind: "group" as const,
  group: {
    id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    name: `team-${index}`,
    provider: "local" as const,
    description: null,
    gidnumber: null,
    personalOwner: null,
  },
  relation: { direct: true },
});

/** Serves the detail page with `total` members, 100 per page, and records the pages the members list read. */
const withMembers = async (total: number, run: (app: ReturnType<typeof server>, pages: number[]) => Promise<void>) => {
  const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };
  const pages: number[] = [];
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
    spyOn(accountsAppService.group, "get").mockResolvedValue({
      id: groupId,
      name: "finance",
      provider: "local",
      description: null,
      gidnumber: null,
      personalOwner: null,
    }),
    spyOn(accountsAppService.accountRequest, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.parent, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.managedGroup, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.member, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.manager, "list").mockResolvedValue(empty),
    // Like the service: a page past the end is empty, but the total still counts every member.
    spyOn(accountsAppService.entity, "list").mockImplementation(async ({ pagination }) => {
      const page = pagination?.page ?? 1;
      const perPage = pagination?.perPage ?? 100;
      pages.push(page);
      const items = Array.from({ length: Math.max(0, Math.min(perPage, total - (page - 1) * perPage)) }, (_, offset) =>
        memberGroup((page - 1) * perPage + offset + 1),
      );
      return { items, page, perPage, total, hasNext: page * perPage < total };
    }),
  ];
  try {
    await run(server(), pages);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

const open = (app: ReturnType<typeof server>, query: string) =>
  app.request(`/app/accounts/groups/${groupId}${query}`, { headers: { "Accept-Language": "en" } });

test("a members page past the end opens the last page with the same filters instead of an empty group", async () => {
  await withMembers(150, async (app) => {
    const response = await open(app, "?list_page=2&list_scope=all&tab=members&indirect=true&page=7");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/app/accounts/groups/${groupId}?list_page=2&list_scope=all&tab=members&indirect=true&page=2`,
    );
  });
  await withMembers(3, async (app) => {
    // With one page left, the URL names no page at all.
    const response = await open(app, "?list_scope=all&page=2");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/app/accounts/groups/${groupId}?list_scope=all`);
  });
});

test("the last page itself and an empty group answer without a redirect", async () => {
  await withMembers(150, async (app) => {
    const response = await open(app, "?page=2");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(">team-101<");
    expect(html).toContain(">team-150<");
    expect(html).not.toContain("This group has no members.");
  });
  await withMembers(0, async (app) => {
    const html = await (await open(app, "")).text();
    expect(html).toContain("This group has no members.");
  });
});

test("opening a group from page 2 of the list shows its first page of members in full", async () => {
  await withMembers(3, async (app, pages) => {
    // The list's paging and scope stay list context: they lead back to the list but do not page the members.
    const response = await open(app, "?list_search=fin&list_page=2&list_scope=managed");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(pages).toEqual([1]);
    for (const name of ["team-1", "team-2", "team-3"]) expect(html).toContain(`>${name}<`);
    expect(html).toContain('href="/app/accounts/groups?search=fin&amp;page=2&amp;scope=managed"');
  });
});
