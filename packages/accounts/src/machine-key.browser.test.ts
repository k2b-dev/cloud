import { afterAll, beforeAll, expect, test } from "bun:test";
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
    entrypoints: [resolve(import.meta.dir, "../test/machine-key.browser-fixture.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "machine-key-dom",
        setup(builder) {
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
  if (!build.success) throw new AggregateError(build.logs, "Machine key browser fixture failed");
  bundle = await build.outputs[0]!.text();
  css = await appHostCss(resolve(import.meta.dir, "../src/styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [390, 768, 1280])
  for (const dark of [false, true]) {
    test(`machine key dialog ${width} ${dark ? "dark" : "light"}: named selection, error recovery and one-time key`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      tab.on("pageerror", (error) => errors.push(error.message));
      let fail = true;
      let submitted: unknown;
      try {
        await tab.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
        await tab.route("https://cloud.example.test/api/admin/identity/service-accounts**", async (route) => {
          if (route.request().method() === "GET")
            return route.fulfill({
              json: {
                items: [
                  { id: "11111111-1111-4111-8111-111111111111", name: "Transcript cleanup robot", kind: "agent" },
                  { id: "22222222-2222-4222-8222-222222222222", name: "Batch model integration", kind: "standalone" },
                ],
              },
            });
          submitted = route.request().postDataJSON();
          return route.fulfill(
            fail
              ? { status: 400, json: { message: "The account is disabled" } }
              : { status: 201, json: { token: "fictional-model-key-for-visual-fixture" } },
          );
        });
        await tab.route("https://cloud.example.test/app/accounts/service-accounts", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html class="${dark ? "dark" : "light"}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-theme="${dark ? "dark" : "light"}"><main id="root" class="p-4"></main><script>${bundle}</script></body></html>`,
          }),
        );
        await tab.goto("https://cloud.example.test/app/accounts/service-accounts");
        await tab.getByRole("button", { name: "Create API key", exact: true }).click();
        const dialog = tab.getByRole("dialog");
        await dialog.getByRole("combobox", { name: "Machine account", exact: true }).click();
        await tab.getByRole("option", { name: /Transcript cleanup robot/ }).click();
        await dialog.getByLabel("Name", { exact: true }).fill("Transcript cleanup");
        expect(await dialog.getByText("AI models only", { exact: true }).count()).toBeGreaterThan(0);
        if (process.env.SHOTS)
          await tab.screenshot({ path: `${process.env.SHOTS}/machine-key-create-${dark ? "dark" : "light"}-${width}.png`, fullPage: true });
        await dialog.getByRole("button", { name: "Create API key", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "The account is disabled" }).waitFor();
        expect(await dialog.getByLabel("Name", { exact: true }).inputValue()).toBe("Transcript cleanup");
        fail = false;
        await dialog.getByRole("button", { name: "Create API key", exact: true }).click();
        await dialog.getByText("fictional-model-key-for-visual-fixture", { exact: true }).waitFor();
        expect(submitted).toEqual({ name: "Transcript cleanup", access: "models", expiresAt: null });
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.SHOTS)
          await tab.screenshot({
            path: `${process.env.SHOTS}/machine-key-created-${dark ? "dark" : "light"}-${width}.png`,
            fullPage: true,
          });
      } finally {
        await tab.close();
      }
    });
  }
