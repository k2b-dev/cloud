import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appHostCss } from "../../ui/test/app-host-fixture";
import { launchBrowser } from "../../ui/test/browser";

const ui = resolve(import.meta.dir, "../../ui");
let browser: Awaited<ReturnType<typeof launchBrowser>>;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../test/group-machine-management.browser-fixture.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "group-machine-management-dom",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, ({ path }) => ({
            path: Bun.resolveSync(resolve(import.meta.dir, "../src", path.slice(2)), import.meta.dir),
          }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Group management browser fixture failed");
  bundle = await build.outputs[0]!.text();
  css = await appHostCss(resolve(import.meta.dir, "../src/styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [390, 768, 1440])
  for (const dark of [false, true]) {
    describe(`group machine managers ${width} ${dark ? "dark" : "light"}`, () => {
      let tab: Awaited<ReturnType<typeof browser.newPage>>;
      let errors: string[];
      let added: boolean;
      let revoked: boolean;
      let failRevoke: boolean;
      let writes: unknown[];
      beforeEach(async () => {
        tab = await browser.newPage({ viewport: { width, height: 900 } });
        errors = [];
        added = false;
        revoked = false;
        failRevoke = true;
        writes = [];
        tab.on("pageerror", (error) => errors.push(error.message));
        await tab.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
        await tab.route("https://cloud.example.test/api/**", async (route) => {
          const req = route.request(),
            url = new URL(req.url());
          if (url.pathname.endsWith("/entities")) {
            expect(url.searchParams.get("service_account_kinds")).toBe("standalone,agent");
            return route.fulfill({
              json: {
                items: [
                  {
                    kind: "service_account",
                    serviceAccount: {
                      id: "22222222-2222-4222-8222-222222222222",
                      name: "Release integration",
                      kind: "standalone",
                      status: "active",
                      appId: null,
                      resourceType: null,
                      resourceId: null,
                    },
                  },
                ],
              },
            });
          }
          if (url.pathname.endsWith("/action-notice")) return route.fulfill({ json: { markdown: null, failed: false } });
          writes.push({ method: req.method(), body: req.postDataJSON() });
          if (req.method() === "POST") added = true;
          else if (failRevoke) return route.fulfill({ status: 409, json: { message: "Refresh the group and try again" } });
          else revoked = true;
          return route.fulfill({ json: { message: "Updated" } });
        });
        await tab.route("https://cloud.example.test/group-fixture.js", (route) =>
          route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle }),
        );
        await tab.route("https://cloud.example.test/app/accounts/groups/team", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html lang="en" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-theme="${dark ? "dark" : "light"}" data-added="${added}" data-revoked="${revoked}"><main id="root" class="p-4"></main><script src="/group-fixture.js"></script></body></html>`,
          }),
        );
        await tab.goto("https://cloud.example.test/app/accounts/groups/team");
        expect(errors).toEqual([]);
        await tab.getByText("Nightly helper", { exact: true }).waitFor();
        expect(await tab.getByText("Manage members", { exact: true }).count()).toBe(1);
        expect(await tab.getByText("No app ID", { exact: true }).count()).toBe(0);
      });
      afterEach(async () => {
        await tab?.close();
      });
      for (const scenario of ["grant", "revoke"] as const)
        test(scenario, async () => {
          if (scenario === "grant") {
            await tab.getByRole("button", { name: "Add", exact: true }).click();
            await tab.getByRole("dialog").getByPlaceholder("Search members…").fill("Release");
            await tab.getByRole("button", { name: /Release integration/ }).click();
            await tab.getByText("Release integration", { exact: true }).waitFor();
            expect(writes[0]).toEqual({ method: "POST", body: { type: "service_account", id: "22222222-2222-4222-8222-222222222222" } });
          } else {
            await tab.getByRole("button", { name: "Remove Nightly helper", exact: true }).click();
            await tab.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
            await tab.getByText("Refresh the group and try again", { exact: true }).waitFor();
            await tab.keyboard.press("Escape");
            failRevoke = false;
            await tab.getByRole("button", { name: "Remove Nightly helper", exact: true }).click();
            await tab.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
            await tab.getByText("Nightly helper", { exact: true }).waitFor({ state: "hidden" });
            expect(writes.at(-1)).toEqual({
              method: "DELETE",
              body: { type: "service_account", id: "11111111-1111-4111-8111-111111111111" },
            });
          }
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(errors).toEqual([]);
        });
    });
  }
