import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { oauthService } from "../service";
import { NORMAL } from "./_components/oauth-fixture-data";

const root = mkdtempSync(join(tmpdir(), "oauth-page-"));
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

const read = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

// A client the list does not hold: it stands beyond the first page, so only its own read can open it.
const beyond = { ...NORMAL[1]!, id: "00000000-0000-4000-8000-000000000777", name: "Archiv-Portal" };

const spies = [
  stubRailSnapshot(),
  spyOn(services, "get").mockResolvedValue("cloud.example.test" as never),
  spyOn(oauthService.client, "list").mockResolvedValue({ items: NORMAL, page: 1, perPage: 50, total: 120, hasNext: true } as never),
  spyOn(oauthService.client, "summary").mockResolvedValue({ total: 120, public: 30, dynamic: 2 }),
];
const get = spyOn(oauthService.client, "get").mockImplementation(async ({ id }) => (id === beyond.id ? beyond : null));
afterEach(() => get.mockClear());
process.once("exit", () => {
  for (const spy of [...spies, get]) spy.mockRestore();
});

const render = async (search: string) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/admin/oauth", ...handler);
  const response = await app.request(`/admin/oauth${search}`, { headers: { "Accept-Language": "de" } });
  const html = await response.text();
  expect(response.status, html).toBe(200);
  return html;
};

test("the clients render on v2 with a statement lead, their figures and three pages", async () => {
  const html = await render("");
  expect(html).toContain('data-k2-part="Workspace"');
  const text = read(html);
  expect(text).toContain("2 selbst registriert");
  expect(text).toContain("Grafana");
  expect(text).toContain("1 / 3");
  expect(get).not.toHaveBeenCalled();
});

test("an open client is read on its own, so it stays open beyond the page; one that is gone says so", async () => {
  const open = read(await render(`?page=2&search=archiv&client=${beyond.id}`));
  expect(get).toHaveBeenCalledWith({ id: beyond.id });
  expect(open).toContain("Archiv-Portal");
  // the ID stands shortened, whole in its copy button
  expect(open).toContain(beyond.clientId.slice(0, 8));
  expect(open).toContain("https://grafana.werkstatt.example/login/generic_oauth");

  const gone = read(await render("?client=00000000-0000-4000-8000-000000000999"));
  expect(gone).toContain("Diesen Client gibt es nicht mehr.");
  // an id that is no id never reaches the store
  get.mockClear();
  expect(read(await render("?client=not-an-id"))).toContain("Diesen Client gibt es nicht mehr.");
  expect(get).not.toHaveBeenCalled();
});

test("the endpoints name this Cloud's public addresses", async () => {
  const text = read(await render("?tab=endpoints"));
  for (const path of ["/.well-known/openid-configuration", "/.well-known/jwks.json", "/oauth/authorize", "/oauth/token", "/oauth/register"])
    expect(text).toContain(`https://cloud.example.test${path}`);
  expect(text).toContain("display_name");
});
