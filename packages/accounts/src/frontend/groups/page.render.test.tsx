import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { accountsAppService, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";

const root = mkdtempSync(join(tmpdir(), "accounts-groups-render-"));
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

const group = (index: number) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
  name: `finance-${index}`,
  provider: "local" as const,
  description: null,
  gidnumber: null,
  personalOwner: null,
});

/** Serves the groups list with `total` groups, 100 per page; a page past the end is empty like the service's. */
const withGroups = async (total: number, run: (app: Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>) => Promise<void>) => {
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
    spyOn(accountsAppService.accountRequest, "list").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 0, hasNext: false }),
    spyOn(accountsAppService.group, "list").mockImplementation(async ({ pagination }) => {
      const page = pagination?.page ?? 1;
      const perPage = pagination?.perPage ?? 100;
      const items = Array.from({ length: Math.max(0, Math.min(perPage, total - (page - 1) * perPage)) }, (_, offset) =>
        group((page - 1) * perPage + offset + 1),
      );
      return { items, page, perPage, total, hasNext: page * perPage < total };
    }),
  ];
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/groups", ...handler);
  try {
    await run(app);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("a group opened from a paged, filtered list carries the list state only as list context", async () => {
  await withGroups(150, async (app) => {
    const response = await app.request("/app/accounts/groups?search=fin&page=2&scope=managed", { headers: { "Accept-Language": "en" } });
    const html = await response.text();
    expect(response.status).toBe(200);
    const detailHrefs = [...html.matchAll(/href="(\/app\/accounts\/groups\/[^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
    expect(detailHrefs.length).toBeGreaterThan(0);
    for (const href of detailHrefs) {
      const params = new URL(href, "https://local.invalid").searchParams;
      // The detail's own `page` and `search` belong to its tabs; the list's state must not page or filter them.
      expect([...params.keys()].sort()).toEqual(["list_page", "list_scope", "list_search"]);
      expect(Object.fromEntries(params)).toEqual({ list_search: "fin", list_page: "2", list_scope: "managed" });
    }
  });
});

test("a list page past the end opens the last page with the same filters", async () => {
  await withGroups(150, async (app) => {
    const response = await app.request("/app/accounts/groups?search=fin&page=5&scope=managed");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/accounts/groups?search=fin&page=2&scope=managed");
  });
  await withGroups(0, async (app) => {
    const response = await app.request("/app/accounts/groups?page=3");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/accounts/groups");
  });
});
