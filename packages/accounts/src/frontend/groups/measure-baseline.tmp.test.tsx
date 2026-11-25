// Scratch measurement: DOM element count and loading marks of the group pages' SSR HTML, v1 baseline vs v2.
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, GroupRelations, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { Hono } from "hono";

const repo = "/home/valentinkolb/.t3/worktrees/cloud/t3-f6120a2d-98257e1e6f42e82e";
const groups = `${repo}/packages/accounts/src/frontend/groups`;
const { stubRailSnapshot } = await import(`${repo}/tests/fixtures/rail-snapshot`);
const { registerSsrTestPlugin } = await import(`${repo}/packages/ui/test/ssr-test-plugin`);
const root = mkdtempSync(join(tmpdir(), "accounts-measure-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const which = process.env.MEASURE ?? "v1";
const detail = (await import(`${groups}/detail/page.tsx`)).default;

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
const groupId = "22222222-2222-4222-8222-222222222222";
const person = (n: number, name: string) => ({
  kind: "user" as const,
  user: {
    ...user,
    id: `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`,
    uid: name.toLowerCase(),
    displayName: name,
    mail: `${name.toLowerCase()}@example.test`,
    roles: ["user"],
  },
  relation: { direct: true },
});
const items = [person(1, "Ada"), person(2, "Milan"), person(3, "Jana"), person(4, "Ole"), person(5, "Rike")];
const all = "00000000-0000-4000-8000-000000000001";
const tech = "00000000-0000-4000-8000-000000000002";
const relations: GroupRelations = {
  focus: tech,
  depth: 2,
  managers: false,
  groupCount: 2,
  nodes: [
    { id: all, name: "All staff", provider: "local", members: 3, contains: 1, inCycle: false },
    { id: tech, name: "Engineering", provider: "ipa", members: 4, contains: 0, inCycle: false },
  ],
  columns: [{ key: "u1", items: [{ id: all, via: tech }], backs: [], hidden: 0 }],
  roots: null,
  selected: {
    id: tech,
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

const count = (html: string) => {
  const body = html.slice(html.indexOf("<body"));
  return {
    elements: (body.match(/<[a-zA-Z][^>]*>/g) ?? []).length,
    loaders: (body.match(/k2-skel|aria-busy="true"|animate-spin|ti-loader/g) ?? []).length,
  };
};

test(`measure ${which}`, async () => {
  const empty = { items: [], page: 1, perPage: 100, total: 0, hasNext: false };
  const spies = [
    stubRailSnapshot(),
    spyOn(coreSettings, "get").mockResolvedValue(false),
    spyOn(linuxIdentities, "configuration").mockResolvedValue({
      enabled: true,
      rangeStart: 10000,
      rangeEnd: 20000,
      homeTemplate: "/home/{uid}",
      loginShell: "/bin/bash",
    }),
    spyOn(accountsAppService.group, "get").mockResolvedValue({
      id: groupId,
      name: "finance",
      provider: "local",
      description: "Buchhaltung und Controlling",
      gidnumber: 10042,
      personalOwner: null,
    }),
    spyOn(accountsAppService.accountRequest, "countPending").mockResolvedValue(0),
    spyOn(accountsAppService.group.parent, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.managedGroup, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.group.member, "list").mockResolvedValue({
      ...empty,
      items: items.map((item) => ({ type: "user", id: item.user.id })),
      total: 5,
    } as never),
    spyOn(accountsAppService.group.manager, "list").mockResolvedValue(empty),
    spyOn(accountsAppService.entity, "list").mockResolvedValue({ items, page: 1, perPage: 100, total: 5, hasNext: false } as never),
    spyOn(accountsAppService.group, "relations").mockResolvedValue({ ok: true, data: relations }),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/groups/:id", ...detail);
  try {
    const out: Record<string, unknown> = {};
    for (const [name, path] of [
      ["detail", `/app/accounts/groups/${groupId}`],
      ["relations", `/app/accounts/groups/${groupId}?tab=relations`],
    ] as const) {
      const response = await app.request(path, { headers: { "Accept-Language": "en" } });
      const html = await response.text();
      expect(response.status, html.slice(0, 2000)).toBe(200);
      out[name] = count(html);
      writeFileSync(
        `/tmp/claude-1000/-home-valentinkolb--t3-worktrees-cloud-t3-f6120a2d-98257e1e6f42e82e/070441ca-e8d9-4620-a200-05262f697d71/scratchpad/measure/${which}-${name}.html`,
        html,
      );
    }
    console.log(`MEASURE ${which} ${JSON.stringify(out)}`);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
