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
  const hosts = spyOn(ipaHostsService.host, "list").mockResolvedValue({
    items: [host("far-away.example.longer"), host("far-away.example", ["archiv"])],
    page: 1,
    perPage: 50,
    total: 2,
    hasNext: false,
  } as never);
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
    expect(text).toContain("von 5.678 insgesamt");
    // the open host is the exact one, though the search finds a longer name first, and it is not on this page
    expect(hosts.mock.calls[0]![0]).toMatchObject({ filter: { query: "far-away.example" } });
    expect(text).toContain("archiv");
    const gone = read(await (await app.request("/admin/ipa-hosts?host=weg.example", { headers: { "Accept-Language": "de" } })).text());
    expect(gone).toContain("Diesen Host gibt es im Spiegel nicht mehr.");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
