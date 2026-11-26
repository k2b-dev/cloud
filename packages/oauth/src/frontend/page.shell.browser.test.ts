import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs } from "../../../ui/test/browser";
import { loadShellAssets, openShellPage, type ShellAssets } from "../../../ui/test/shell-page";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { oauthService } from "../service";
import { NORMAL, WORST } from "./_components/oauth-fixture-data";

// The real page in the Cloud shell, from invented clients: its first HTML with the shell's own stylesheets, fonts
// (Plex) and icons keeps the v2 layout rules at 1440 and 390 px. `CLOUD_OAUTH_SHELL_SHOTS=<dir>` also saves light
// pictures.
const root = mkdtempSync(join(tmpdir(), "oauth-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const shots = process.env.CLOUD_OAUTH_SHELL_SHOTS;

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
const clientsOf = (data: Data) => (data === "normal" ? NORMAL : data === "worst" ? WORST : []);

/** The first HTML of an address, as the page renders it for invented clients. */
const firstHtml = async (search: string, data: Data) => {
  const clients = clientsOf(data);
  const spies = [
    stubRailSnapshot(),
    spyOn(services, "get").mockResolvedValue("cloud.example.test" as never),
    spyOn(oauthService.client, "list").mockResolvedValue({
      items: clients,
      page: 1,
      perPage: 50,
      total: data === "worst" ? 12_345 : clients.length,
      hasNext: data === "worst",
    } as never),
    spyOn(oauthService.client, "summary").mockResolvedValue(
      data === "worst"
        ? { total: 12_345, public: 4_321, dynamic: 9_876 }
        : {
            total: clients.length,
            public: clients.filter((client) => client.isPublic).length,
            dynamic: clients.filter((client) => client.registrationKind === "dynamic").length,
          },
    ),
    spyOn(oauthService.client, "get").mockImplementation(async ({ id }) => clients.find((client) => client.id === id) ?? null),
  ];
  try {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/admin/oauth", ...handler);
    return await (await app.request(`/admin/oauth${search}`, { headers: { "Accept-Language": "de" } })).text();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

let browser: Browser;
let assets: ShellAssets;
beforeAll(async () => {
  assets = await loadShellAssets({ id: "oauth", css: resolve(import.meta.dir, "../styles/app.css") });
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

describe("OAuth in the Cloud shell", () => {
  test("the first picture keeps the v2 rules at 1440 and 390 px: list, open client, endpoints, empty and worst case", async () => {
    const cases: [string, string, Data][] = [
      ["clients", "", "normal"],
      ["client-offen", `?client=${NORMAL[2]!.id}`, "normal"],
      ["client-dynamisch", `?client=${NORMAL[4]!.id}`, "normal"],
      ["endpunkte", "?tab=endpoints", "normal"],
      ["leer", "", "empty"],
      ["worst-case", "", "worst"],
      ["worst-case-offen", `?client=${WORST[0]!.id}`, "worst"],
    ];
    for (const [name, search, data] of cases) {
      const html = await firstHtml(search, data);
      for (const width of [1440, 390]) {
        const { context, tab, errors } = await openShellPage(browser, assets, { path: `/admin/oauth${search}`, html, width });
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
