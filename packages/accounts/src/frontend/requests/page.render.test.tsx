import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "accounts-requests-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
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

const request = (id: string, status: "pending" | "completed" | "denied", firstName: string, lastName: string) => ({
  id,
  email: `${firstName.toLowerCase()}@solberg-kramer.example`,
  firstName,
  lastName,
  displayName: null,
  phone: null,
  comment: status === "pending" ? "Neu im Lager ab Dezember" : null,
  status,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
});

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/accounts/requests", ...handler);
  return app;
};

const withRequests = async (freeIpa: boolean, run: (app: ReturnType<typeof server>, list: ReturnType<typeof spyOn>) => Promise<void>) => {
  const list = spyOn(services.accountsAppService.accountRequest, "list").mockImplementation(async ({ filter }) => {
    const items = [
      request("aaaaaaaa-0000-4000-8000-000000000001", "pending", "Jonas", "Weber"),
      request("aaaaaaaa-0000-4000-8000-000000000002", "denied", "Mira", "Kaya"),
    ].filter((item) => !filter || !("status" in filter) || item.status === filter.status);
    return { items, page: 1, perPage: 100, total: items.length, hasNext: false } as never;
  });
  const spies = [
    stubRailSnapshot(),
    spyOn(services.coreSettings, "get").mockResolvedValue(freeIpa),
    list,
    spyOn(services.accountsAppService.accountRequest, "countPending").mockResolvedValue(1),
  ];
  try {
    await run(server(), list);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

test("request status is a view in the address, with Pending as the default, rendered on v2", async () => {
  await withRequests(true, async (app) => {
    for (const [query, current] of [
      ["?status=completed", "completed"],
      ["", "pending"],
    ] as const) {
      const response = await app.request(`/app/accounts/requests${query}`, { headers: { "Accept-Language": "en" } });
      const html = await response.text();
      expect(response.status, html).toBe(200);
      expect(html).toContain('data-k2-part="Workspace"');
      const tabs = html.match(/<[^>]*data-k2-part="Tabs"[^>]*aria-label="Request status"[\s\S]*?<\/nav>/)?.[0] ?? "";
      const links = [...tabs.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      expect(links).toHaveLength(4);
      for (const [index, status] of ["pending", "completed", "denied", "all"].entries()) {
        const [, attrs, content] = links[index]!;
        expect(attrs).toContain(`href="/app/accounts/requests${status === "pending" ? "" : `?status=${status}`}"`);
        expect(content).toContain(status[0]!.toUpperCase() + status.slice(1));
        expect(attrs!.includes('aria-current="page"')).toBe(status === current);
      }
    }
  });
});

test("a pending request offers create (with FreeIPA) and deny; the head creates a user on its page; no loader on first render", async () => {
  await withRequests(true, async (app, list) => {
    const response = await app.request("/app/accounts/requests", { headers: { "Accept-Language": "en" } });
    const html = await response.text();
    expect(list.mock.calls[0]![0]).toMatchObject({ filter: { status: "pending" }, pagination: { page: 1, perPage: 100 } });
    expect(html).toContain("Jonas Weber");
    expect(html).toContain("Neu im Lager ab Dezember");
    expect(html).toContain('href="/app/accounts/users/new?request=aaaaaaaa-0000-4000-8000-000000000001"');
    expect(html).toContain(">Deny<");
    expect(html).toContain('href="/app/accounts/users/new"');
    expect(html).not.toContain('data-k2-part="Loading"');
    console.info(`requests v2 DOM elements: ${html.match(/<[a-z][a-z0-9-]*/gi)?.length}`);
  });
  await withRequests(false, async (app) => {
    const html = await (await app.request("/app/accounts/requests", { headers: { "Accept-Language": "en" } })).text();
    expect(html).not.toContain("/app/accounts/users/new?request=");
    expect(html).toContain(">Deny<");
  });
});
