import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { IpaHost } from "../contracts";
import { ipaHostsService } from "../service";
import { denseGroups, denseUngrouped } from "./_components/hosts-fixture-data";

// The real page in the Cloud shell, from invented hosts: its first HTML with the shell's own stylesheets and fonts keeps
// the v2 layout rules at 1440 and 390 px. `CLOUD_IPA_HOSTS_SHELL_SHOTS=<dir>` also saves light pictures.
const root = mkdtempSync(join(tmpdir(), "ipa-hosts-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><path d="M9 20a5 5 0 0 1 1-9.9A7 7 0 0 1 23 12a4 4 0 0 1 0 8z" fill="#fff"/></svg>';
const shots = process.env.CLOUD_IPA_HOSTS_SHELL_SHOTS;
const origin = "https://cloud.example.test";

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

const host = (fqdn: string, extra: Partial<IpaHost> = {}): IpaHost => ({
  fqdn,
  description: null,
  location: null,
  locality: null,
  memberofHostgroup: [],
  macAddress: [],
  platform: null,
  osVersion: null,
  sshFingerprints: [],
  ...extra,
});
const LONG = "kunden-und-auftraege-werkstatt-nord-zeiterfassung-und-materialbestellung-01.intern.werkstatt-nord.example";
const DATA = {
  normal: {
    groups: [
      {
        cn: "server",
        description: "Server im Rechenraum",
        members: ["db1.werkstatt.example", "app1.werkstatt.example", "backup.werkstatt.example"],
      },
      { cn: "drucker", description: "Drucker und Scanner", members: ["drucker-buero.werkstatt.example"] },
      { cn: "arbeitsplaetze", description: null, members: ["pc-01.werkstatt.example", "pc-02.werkstatt.example"] },
    ],
    ungrouped: [host("neu-01.werkstatt.example", { locality: "Lager" }), host("laptop-azubi.werkstatt.example")],
  },
  worst: {
    groups: [
      {
        cn: "werkstatt-nord-schichtbetrieb-maschinen-und-messplaetze-im-erdgeschoss",
        description: "Alle Maschinen, Messplätze und Bedienterminals der Werkstatt Nord im Erdgeschoss, die im Schichtbetrieb laufen",
        members: [LONG],
      },
      { cn: "x", description: null, members: [] },
    ],
    ungrouped: [host("a"), host(LONG.replace("01", "02"), { macAddress: ["AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:F1"] })],
  },
  empty: { groups: [], ungrouped: [] },
} as const;
type Data = keyof typeof DATA;
const groupsOf = (data: Data) =>
  data === "normal"
    ? denseGroups()
    : DATA[data].groups.map((group) => ({
        cn: group.cn,
        description: group.description,
        hosts: [...group.members],
        hostgroups: [],
        hostDetails: group.members.map((fqdn, index) =>
          host(fqdn, {
            description: index === 0 ? (data === "worst" ? "Терминал · 工作站 · محطة عمل 🖥️" : "Hauptsystem") : null,
            locality: data === "worst" ? "Werkstatt Nord, Erdgeschoss, Halle 7 (Anbau)" : "Halle 2",
            location: index === 0 ? "Rack A3" : null,
            memberofHostgroup: data === "worst" ? Array.from({ length: 8 }, (_, at) => `gruppe-${at + 1}`) : [group.cn],
            macAddress:
              data === "worst" ? Array.from({ length: 6 }, (_, at) => `AA:BB:CC:DD:EE:0${at}`) : index === 0 ? ["AA:BB:CC:00:11:22"] : [],
            platform: "x86_64",
            osVersion: "Debian 13",
            sshFingerprints: index === 0 ? ["SHA256:7f3a9c2e1b4d4e8a9c0d2b6f1e3a5d7c (ED25519)"] : [],
          }),
        ),
      }));

let browser: Browser;
let stylesheets: Record<string, string>;
let uiDist: string;
let iconFont: string;
beforeAll(async () => {
  uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)?.[0] ?? "";
  const build = async (entry: string) => {
    const result = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
    return result.outputs[0]!.text();
  };
  stylesheets = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
    "/public/global.css": await build(resolve(import.meta.dir, "../../../../styles.css")),
    "/public/ipa-hosts/app.css": await build(resolve(import.meta.dir, "../styles/app.css")),
  };
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The first HTML of an address, as the page renders it for invented clients. */
const firstHtml = async (search: string, data: Data) => {
  const groups = groupsOf(data);
  const ungrouped = data === "normal" ? denseUngrouped() : [...DATA[data].ungrouped];
  const everyHost = [...groups.flatMap((group) => group.hostDetails), ...ungrouped];
  const spies = [
    stubRailSnapshot(),
    spyOn(ipaHostsService.hostgroup, "listWithHosts").mockImplementation(async ({ filter }) => {
      const items = filter?.query ? groups.filter((group) => group.cn.includes(filter.query ?? "")) : groups;
      return { items, page: 1, perPage: 100, total: data === "worst" && !filter?.query ? 12_345 : items.length, hasNext: false };
    }),
    spyOn(ipaHostsService.host, "listUngrouped").mockResolvedValue({
      items: ungrouped,
      page: 1,
      perPage: 100,
      total: data === "worst" ? 24_691 : ungrouped.length,
      hasNext: false,
    } as never),
    spyOn(ipaHostsService.host, "list").mockImplementation(
      async ({ filter }) =>
        ({
          items: everyHost.filter((candidate) => candidate.fqdn.includes(filter?.query ?? "")),
          page: 1,
          perPage: 50,
          total: 1,
          hasNext: false,
        }) as never,
    ),
    spyOn(ipaHostsService, "stats").mockResolvedValue({
      hostsInGroups: data === "worst" ? 98_765 : groups.reduce((sum, group) => sum + group.hostDetails.length, 0),
      hostsTotal: data === "worst" ? 123_456 : everyHost.length,
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

describe("Hosts in the Cloud shell", () => {
  test("the first picture keeps the v2 rules at 1440 and 390 px: groups, an open group and host, ungrouped, empty and worst case", async () => {
    const cases: [string, string, Data][] = [
      ["hostgruppen", "", "normal"],
      ["gruppe-offen", "?group=server", "normal"],
      ["host-offen", "?group=server&host=db1.werkstatt.example", "normal"],
      ["ohne-gruppe", "?tab=ungrouped", "normal"],
      ["leer", "", "empty"],
      ["worst-case", "", "worst"],
      ["worst-case-host", `?host=${LONG}`, "worst"],
    ];
    for (const [name, search, data] of cases) {
      const html = await firstHtml(search, data);
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          deviceScaleFactor: 1,
          isMobile: width === 390,
          hasTouch: width === 390,
          reducedMotion: "reduce",
          colorScheme: "light",
        });
        const tab = await context.newPage();
        const errors = pageErrors(tab);
        await tab.route(`${origin}/**`, async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/admin/ipa-hosts") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
          if (stylesheets[url.pathname]) return route.fulfill({ contentType: "text/css", body: stylesheets[url.pathname] });
          if (url.pathname === "/public/tabler-icons.woff2") return route.fulfill({ path: resolve(uiDist, iconFont) });
          if (url.pathname.startsWith("/public/fonts/")) {
            const fonts = resolve(uiDist, "fonts");
            const path = resolve(fonts, url.pathname.slice("/public/fonts/".length));
            return path.startsWith(`${fonts}/`) ? route.fulfill({ path }) : route.fulfill({ status: 404 });
          }
          // the shell's logos and app symbols: one invented mark, so no picture shows a broken image
          if (route.request().resourceType() === "image") return route.fulfill({ contentType: "image/svg+xml", body: LOGO });
          // the islands stay as the server drew them: this is the first picture
          return route.fulfill({ status: 404, body: "" });
        });
        try {
          await tab.goto(`${origin}/admin/ipa-hosts${search}`);
          await tab.evaluate(() => window.document.fonts.ready);
          await settled(tab);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          // only the islands' scripts may be missing here
          expect(errors.filter((error) => !/Failed to load|404|import/i.test(String(error)))).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);
});
