import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { cloudShellSheets } from "../../../../scripts/fixtures/cloud-shell-sheets";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
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
// after the compiler is registered: the navigation module renders JSX
const { adminNavigation } = await import("@k2b/cloud/ssr");
const shots = process.env.CLOUD_IPA_HOSTS_SHELL_SHOTS;
const ui = resolve(import.meta.dir, "../../../ui");

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

// This app as the registry lists it, so the admin navigation has its entry and marks it current.
const runtime = {
  apps: [
    { id: "ipa-hosts", name: "Hosts", icon: "ti ti-server", description: "", adminHref: "/admin/ipa-hosts", routes: ["/admin/ipa-hosts"] },
  ],
} as unknown as CloudRuntime;

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
    // a search finds groups by name, description or the name of one of their hosts, as the mirror's query does
    spyOn(ipaHostsService.hostgroup, "listWithHosts").mockImplementation(async ({ filter }) => {
      const query = filter?.query?.toLowerCase();
      const found = query
        ? groups.filter((group) =>
            [group.cn, group.description ?? "", ...group.hostDetails.map((host) => host.fqdn)].some((text) =>
              text.toLowerCase().includes(query),
            ),
          )
        : groups;
      return {
        items: found.slice(0, 100),
        page: 1,
        perPage: 100,
        total: data === "worst" ? 12_345 : found.length,
        hasNext: data === "worst",
      };
    }),
    spyOn(ipaHostsService.host, "listUngrouped").mockResolvedValue({
      items: ungrouped,
      page: 1,
      perPage: 100,
      total: data === "worst" ? 24_691 : ungrouped.length,
      hasNext: false,
    } as never),
    spyOn(ipaHostsService.hostgroup, "getWithHosts").mockImplementation(async ({ cn }) => {
      const group = groups.find((candidate) => candidate.cn === cn);
      // the long group of the worst case holds thousands of hosts; the page shows its first 50
      return group ? { ...group, hostTotal: data === "worst" && cn === LONG_GROUP ? 4_321 : group.hostDetails.length } : null;
    }),
    spyOn(ipaHostsService.host, "get").mockImplementation(async ({ fqdn }) => hosts.find((host) => host.fqdn === fqdn) ?? null),
    spyOn(ipaHostsService, "stats").mockResolvedValue({
      hostsInGroups: data === "worst" ? 98_765 : groups.reduce((sum, group) => sum + group.hostDetails.length, 0),
      hostsTotal: data === "worst" ? 123_456 : hosts.length,
      hostsUngrouped: data === "worst" ? 24_691 : ungrouped.length,
      hostgroupsTotal: data === "worst" ? 12_345 : groups.length,
      // the last sync twelve minutes ago, whatever day the test runs
      lastSyncedAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    } as never),
  ];
  try {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", runtime);
      await next();
    });
    app.get("/admin/ipa-hosts", async (c, next) => {
      if (c.req.query("nav") === "") return c.json(adminNavigation(c));
      await next();
    });
    app.get("/admin/ipa-hosts", ...handler);
    return await (await app.request(`/admin/ipa-hosts${search}`, { headers: { "Accept-Language": "de" } })).text();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

/** The screen's shell harness: the fixture rendered into the real page's island. */
const buildShellHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "_components/HostsScreen.shell-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-ipa-hosts-shell",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Hosts shell harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let assets: ShellAssets;
let harness: string;
beforeAll(async () => {
  assets = await loadShellAssets(
    await cloudShellSheets({ id: "ipa-hosts", css: resolve(import.meta.dir, "../styles/app.css") }, import.meta.dir),
  );
  harness = await buildShellHarness();
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
      // a host's name finds its groups, and each row says which of its hosts was found
      ["suche", "?search=db1", "normal"],
      ["leer", "", "empty"],
      ["worst-case", "", "worst"],
      ["worst-case-gruppe", `?group=${LONG_GROUP}`, "worst"],
      ["worst-case-host", `?host=${LONG_HOST}`, "worst"],
    ];
    for (const [name, search, data] of cases) {
      const html = await firstHtml(search, data);
      for (const width of [1440, 1024, 390]) {
        const { context, tab, errors } = await openShellPage(browser, assets, { path: `/admin/ipa-hosts${search}`, html, width });
        try {
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
          // the page's own entry is the current one in the admin navigation, not the overview
          if (width === 1440) expect(await tab.locator('[aria-current="page"]').first().innerText()).toBe("Hosts");
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);

  test("a new group and adding a host to groups open their dialogs in the shell's frame", async () => {
    const nav = (await firstHtml("?nav", "normal")).replaceAll("<", "\\u003c");
    for (const [name, search] of [
      ["dialog-neue-gruppe", ""],
      ["dialog-zu-gruppen", "?group=server&host=db1.werkstatt.example"],
    ] as const) {
      const html = await firstHtml(search, "normal");
      for (const width of [1440, 1024, 390]) {
        const { context, tab, errors } = await openShellPage(browser, assets, {
          path: `/admin/ipa-hosts${search}`,
          html,
          width,
          extra: {
            html: `<script type="application/json" id="shell-nav">${nav}</script><script src="/__shell-harness.js"></script>`,
            files: {
              "/__shell-harness.js": { type: "text/javascript; charset=utf-8", body: harness },
              "/api/ipa-hosts/hostgroups/search": {
                type: "application/json",
                body: JSON.stringify({
                  // enough groups for "a" that the dialog shows a list beside the chosen ones
                  hostgroups: [
                    { cn: "arbeitsplaetze", description: "PCs in Büro und Werkstatt" },
                    { cn: "drucker", description: "Drucker und Scanner" },
                    { cn: "kameras", description: null },
                    { cn: "lager", description: "Scanner und Etikettendrucker im Lager" },
                    { cn: "laptops", description: "Mobile Geräte der Bauleitung" },
                    { cn: "maschinen", description: "Steuerrechner der Maschinen" },
                    { cn: "telefonie", description: "Telefonanlage" },
                  ],
                }),
              },
            },
          },
        });
        try {
          if (name === "dialog-neue-gruppe") {
            await tab.getByRole("button", { name: "Neue Hostgruppe" }).first().click();
            await tab.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("werkstatt-sued");
          } else {
            // k2b-ui gap: on the phone a section action keeps only its symbol and loses its name (DP); found by its section
            await tab.getByRole("region", { name: "Hostgruppen" }).getByRole("button").first().click();
            const dialog = tab.getByRole("dialog");
            await dialog.getByRole("searchbox").fill("a");
            await dialog.getByRole("option", { name: /^drucker/ }).click();
          }
          await settled(tab);
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 120_000);
});
