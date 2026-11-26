import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { ipaHostsService } from "../service";

const root = mkdtempSync(join(tmpdir(), "ipa-hosts-page-"));
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

const host = (fqdn: string, groups: string[] = []) => ({
  fqdn,
  description: null,
  location: null,
  locality: "Halle 2",
  memberofHostgroup: groups,
  macAddress: ["AA:BB:CC:00:11:22"],
  platform: null,
  osVersion: null,
  sshFingerprints: [],
});

test("hosts render on v2; an open host is read on its own, so it stays open outside the page and the search", async () => {
  const groups = spyOn(ipaHostsService.hostgroup, "listWithHosts").mockImplementation(async ({ filter }) => ({
    items: [
      { cn: "server", description: "Rechenraum", hosts: ["db1.example"], hostgroups: [], hostDetails: [host("db1.example", ["server"])] },
    ],
    page: 1,
    perPage: 100,
    total: filter?.query === "server" ? 1 : 12_345,
    hasNext: false,
  }));
  const hosts = spyOn(ipaHostsService.host, "get").mockImplementation(async ({ fqdn }) =>
    fqdn === "far-away.example" ? host("far-away.example", ["archiv"]) : null,
  );
  const spies = [
    stubRailSnapshot(),
    groups,
    hosts,
    spyOn(ipaHostsService.host, "listUngrouped").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 7, hasNext: false } as never),
    spyOn(ipaHostsService, "stats").mockResolvedValue({ hostsInGroups: 1_234, hostsTotal: 5_678 } as never),
  ];
  try {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/admin/ipa-hosts", ...handler);
    const response = await app.request("/admin/ipa-hosts?search=server&host=far-away.example", { headers: { "Accept-Language": "de" } });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain('data-k2-part="Workspace"');
    const text = read(html);
    expect(text).toContain("7 Hosts sind keiner Gruppe zugeordnet");
    expect(text).toContain("1.234 in Gruppen");
    // the lead says it once: no chip, figure or tab count repeats the hosts without a group
    expect(text).not.toContain("Zuordnung erforderlich");
    // the open host is read by its exact name, though it is not on this page and the search names something else
    expect(hosts.mock.calls[0]![0]).toEqual({ fqdn: "far-away.example" });
    expect(text).toContain("archiv");
    const gone = read(await (await app.request("/admin/ipa-hosts?host=weg.example", { headers: { "Accept-Language": "de" } })).text());
    expect(gone).toContain("Diesen Host gibt es im Spiegel nicht mehr.");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("an open group pages its hosts: the pager names the page, a host keeps it for the way back, a page past the end opens the last", async () => {
  const members = Array.from({ length: 120 }, (_, index) => host(`h${String(index).padStart(3, "0")}.example`, ["server"]));
  const read50 = spyOn(ipaHostsService.hostgroup, "getWithHosts").mockImplementation(async ({ cn, page, perPage }) =>
    cn === "server"
      ? {
          cn,
          description: null,
          hosts: [],
          hostgroups: [],
          hostDetails: members.slice((page - 1) * perPage, page * perPage),
          hostTotal: members.length,
        }
      : null,
  );
  const spies = [
    stubRailSnapshot(),
    read50,
    spyOn(ipaHostsService.hostgroup, "listWithHosts").mockResolvedValue({
      items: [],
      page: 1,
      perPage: 100,
      total: 1,
      hasNext: false,
    } as never),
    spyOn(ipaHostsService.host, "listUngrouped").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 0, hasNext: false } as never),
    spyOn(ipaHostsService.host, "get").mockResolvedValue(null),
    spyOn(ipaHostsService, "stats").mockResolvedValue({ hostsInGroups: 120, hostsTotal: 120 } as never),
  ];
  try {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/admin/ipa-hosts", ...handler);
    const html = await (await app.request("/admin/ipa-hosts?group=server&hosts_page=2", { headers: { "Accept-Language": "de" } })).text();
    expect(read50.mock.calls[0]![0]).toEqual({ cn: "server", page: 2, perPage: 50 });
    expect(read(html)).toContain("2 / 3");
    expect(read(html)).toContain("h050.example");
    expect(html).toContain("hosts_page=3");
    // a host opened from page 2 leads back to page 2
    expect(html).toMatch(/href="[^"]*host=h050\.example[^"]*"/);
    expect(html).toMatch(/group=server&amp;host=h050\.example&amp;hosts_page=2|group=server&amp;hosts_page=2&amp;host=h050\.example/);
    const past = await app.request("/admin/ipa-hosts?group=server&hosts_page=9", { headers: { "Accept-Language": "de" } });
    expect(past.status).toBe(302);
    expect(past.headers.get("location")).toBe("/admin/ipa-hosts?group=server&hosts_page=3");
    // a page number whose offset no database takes opens the first page
    const huge = await app.request(`/admin/ipa-hosts?group=server&hosts_page=${Number.MAX_SAFE_INTEGER}`, {
      headers: { "Accept-Language": "de" },
    });
    expect(huge.status).toBe(200);
    expect(read50.mock.calls.at(-1)![0]).toEqual({ cn: "server", page: 1, perPage: 50 });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
