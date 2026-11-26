import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs } from "../../../ui/test/browser";
import { loadShellAssets, openShellPage, type ShellAssets } from "../../../ui/test/shell-page";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { ipaHostsService } from "../service";
import { denseGroups, denseUngrouped, LONG_GROUP, LONG_HOST, worstGroups, worstUngrouped } from "./_components/hosts-fixture-data";

// The real page in the Cloud shell, from invented hosts: its first HTML with the shell's own stylesheets, Plex fonts and
// icons keeps the v2 layout rules at 1440 and 390 px. `CLOUD_IPA_HOSTS_SHELL_SHOTS=<dir>` also saves light pictures.
const root = mkdtempSync(join(tmpdir(), "ipa-hosts-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const shots = process.env.CLOUD_IPA_HOSTS_SHELL_SHOTS;

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

type Data = "normal" | "worst" | "empty";
const dataOf = (data: Data) =>
  data === "normal"
    ? { groups: denseGroups(), ungrouped: denseUngrouped() }
    : data === "worst"
      ? { groups: worstGroups(), ungrouped: worstUngrouped() }
      : { groups: [], ungrouped: [] };

/** The first HTML of an address, as the page renders it from the invented mirror. */
const firstHtml = async (search: string, data: Data) => {
  const { groups, ungrouped } = dataOf(data);
  const hosts = [...groups.flatMap((group) => group.hostDetails), ...ungrouped];
  const spies = [
    stubRailSnapshot(),
    spyOn(ipaHostsService.hostgroup, "listWithHosts").mockResolvedValue({
      items: groups.slice(0, 100),
      page: 1,
      perPage: 100,
      total: data === "worst" ? 12_345 : groups.length,
      hasNext: data === "worst",
    }),
    spyOn(ipaHostsService.host, "listUngrouped").mockResolvedValue({
      items: ungrouped,
      page: 1,
      perPage: 100,
      total: data === "worst" ? 24_691 : ungrouped.length,
      hasNext: false,
    } as never),
    spyOn(ipaHostsService.hostgroup, "getWithHosts").mockImplementation(async ({ cn }) => groups.find((group) => group.cn === cn) ?? null),
    spyOn(ipaHostsService.host, "get").mockImplementation(async ({ fqdn }) => hosts.find((host) => host.fqdn === fqdn) ?? null),
    spyOn(ipaHostsService, "stats").mockResolvedValue({
      hostsInGroups: data === "worst" ? 98_765 : groups.reduce((sum, group) => sum + group.hostDetails.length, 0),
      hostsTotal: data === "worst" ? 123_456 : hosts.length,
    } as never),
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
    return await (await app.request(`/admin/ipa-hosts${search}`, { headers: { "Accept-Language": "de" } })).text();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

let browser: Browser;
let assets: ShellAssets;
beforeAll(async () => {
  assets = await loadShellAssets({ id: "ipa-hosts", css: resolve(import.meta.dir, "../styles/app.css") });
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

describe("Hosts in the Cloud shell", () => {
  test("the first picture keeps the v2 rules at 1440 and 390 px: groups, an open group and host, ungrouped, empty and worst case", async () => {
    const cases: [string, string, Data][] = [
      ["hostgruppen", "", "normal"],
      ["gruppe-offen", "?group=server", "normal"],
      ["host-offen", "?group=server&host=db1.werkstatt.example", "normal"],
      ["ohne-gruppe", "?tab=ungrouped", "normal"],
      ["leer", "", "empty"],
      ["worst-case", "", "worst"],
      ["worst-case-gruppe", `?group=${LONG_GROUP}`, "worst"],
      ["worst-case-host", `?host=${LONG_HOST}`, "worst"],
    ];
    for (const [name, search, data] of cases) {
      const html = await firstHtml(search, data);
      for (const width of [1440, 390]) {
        const { context, tab, errors } = await openShellPage(browser, assets, { path: `/admin/ipa-hosts${search}`, html, width });
        try {
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);
});
