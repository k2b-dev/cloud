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
import { cloudShellSheets } from "../../../../scripts/fixtures/cloud-shell-sheets";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { loadShellAssets, openShellPage, type ShellAssets } from "../../../ui/test/shell-page";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { oauthService } from "../service";
import { FAKE_SECRET, NORMAL, WORST } from "./_components/oauth-fixture-data";

// The real page in the Cloud shell, from invented clients: its first HTML with the shell's own stylesheets, fonts
// (Plex) and icons keeps the v2 layout rules at 1440 and 390 px. `CLOUD_OAUTH_SHELL_SHOTS=<dir>` also saves light
// pictures.
const root = mkdtempSync(join(tmpdir(), "oauth-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
// after the compiler is registered: the navigation module renders JSX
const { adminNavigation } = await import("@k2b/cloud/ssr");
const shots = process.env.CLOUD_OAUTH_SHELL_SHOTS;
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
  apps: [{ id: "oauth", name: "OAuth", icon: "ti ti-key", description: "", adminHref: "/admin/oauth", routes: ["/admin/oauth"] }],
} as unknown as CloudRuntime;

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
      c.set("runtime", runtime);
      await next();
    });
    app.get("/admin/oauth", async (c, next) => {
      if (c.req.query("nav") === "") return c.json(adminNavigation(c));
      await next();
    });
    app.get("/admin/oauth", ...handler);
    return await (await app.request(`/admin/oauth${search}`, { headers: { "Accept-Language": "de" } })).text();
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
    entrypoints: [resolve(import.meta.dir, "_components/OAuthScreen.shell-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-oauth-shell",
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
  if (!build.success) throw new AggregateError(build.logs, "OAuth shell harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let assets: ShellAssets;
let harness: string;
beforeAll(async () => {
  assets = await loadShellAssets(
    await cloudShellSheets({ id: "oauth", css: resolve(import.meta.dir, "../styles/app.css"), v2Page: true }, import.meta.dir),
  );
  harness = await buildShellHarness();
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
      for (const width of [1440, 1024, 390]) {
        const { context, tab, errors } = await openShellPage(browser, assets, { path: `/admin/oauth${search}`, html, width });
        try {
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
          // the page's own entry is the current one in the admin navigation, not the overview
          if (width === 1440) expect(await tab.locator('[aria-current="page"]').first().innerText()).toBe("OAuth");
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);

  test("a new client, its access and its secret open in the shell's frame; the secret is a fake", async () => {
    const nav = (await firstHtml("?nav", "normal")).replaceAll("<", "\\u003c");
    const html = await firstHtml("", "normal");
    for (const width of [1440, 1024, 390]) {
      const { context, tab, errors } = await openShellPage(browser, assets, {
        path: "/admin/oauth",
        html,
        width,
        extra: {
          html: `<script type="application/json" id="shell-nav">${nav}</script><script src="/__shell-harness.js"></script>`,
          files: {
            "/__shell-harness.js": { type: "text/javascript; charset=utf-8", body: harness },
            "/api/accounts/entities": {
              type: "application/json",
              body: JSON.stringify({
                items: [
                  { kind: "user", user: { id: "11111111-1111-4111-8111-000000000007", uid: "ada", displayName: "Ada Renz" } },
                  { kind: "group", group: { id: "22222222-2222-4222-8222-000000000007", name: "betrieb" } },
                ],
              }),
            },
            "/api/oauth/admin/clients": {
              type: "application/json",
              body: JSON.stringify({ clientId: "oc_wiki", clientSecret: FAKE_SECRET }),
            },
          },
        },
      });
      try {
        await tab.getByRole("button", { name: "Neuer Client" }).first().click();
        const dialog = tab.getByRole("dialog");
        await dialog.getByRole("textbox", { name: "Name" }).fill("Wiki");
        await dialog.getByRole("textbox", { name: "Weiterleitungs-URIs" }).fill("https://wiki.werkstatt.example/login/callback");
        await settled(tab);
        if (shots) await tab.screenshot({ path: join(shots, `dialog-neuer-client-${width}.png`) });
        await dialog.getByRole("checkbox", { name: "Nur bestimmte Benutzer und Gruppen" }).check();
        await dialog.getByRole("searchbox").fill("a");
        await dialog.getByRole("option", { name: /Ada Renz/ }).click();
        await settled(tab);
        if (shots) await tab.screenshot({ path: join(shots, `dialog-zugriff-${width}.png`) });
        await dialog.getByRole("button", { name: "Erstellen" }).click();
        await tab.getByRole("dialog", { name: "Client erstellt" }).getByText(FAKE_SECRET).waitFor();
        await settled(tab);
        if (shots) await tab.screenshot({ path: join(shots, `dialog-secret-${width}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);
});
