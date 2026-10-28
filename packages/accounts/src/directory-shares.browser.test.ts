import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appHostCss } from "../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors } from "../../ui/test/browser";

const ui = resolve(import.meta.dir, "../../ui");
let browser: Awaited<ReturnType<typeof launchBrowser>>;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../test/directory-shares.browser-fixture.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "directory-shares-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Directory shares browser fixture failed");
  bundle = await build.outputs[0]!.text();
  css = await appHostCss(resolve(import.meta.dir, "../src/styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [390, 768, 1440])
  for (const dark of [false, true]) {
    test(`directory access ${width} ${dark ? "dark" : "light"}: exact share, error recovery and revoke`, async () => {
      const tab = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = pageErrors(tab);
      let fail = true,
        granted = false;
      const writes: unknown[] = [];
      const machineId = "11111111-1111-4111-8111-111111111111",
        personId = "22222222-2222-4222-8222-222222222222";
      try {
        await tab.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
        await tab.route("https://cloud.example.test/api/**", async (route) => {
          const req = route.request(),
            url = new URL(req.url());
          if (url.pathname.endsWith("/service-accounts"))
            return route.fulfill({ json: { items: [{ id: machineId, name: "Release helper", kind: "agent" }] } });
          if (url.pathname.endsWith("/entities"))
            return route.fulfill({
              json: { items: [{ kind: "user", user: { id: personId, uid: "ada", displayName: "Ada Example", avatarHash: null } }] },
            });
          if (req.method() === "POST") {
            writes.push(req.postDataJSON());
            if (fail) return route.fulfill({ status: 503, json: { message: "Unavailable" } });
            granted = true;
            return route.fulfill({ status: 201, json: { id: "share-one" } });
          }
          if (req.method() === "DELETE") {
            granted = false;
            return route.fulfill({ json: { ok: true } });
          }
          return route.fulfill({
            json: {
              items: granted
                ? [{ id: "share-one", label: "Ada Example", principal: { type: "user", userId: personId }, serviceAccountKind: null }]
                : [],
              total: granted ? 1 : 0,
              page: 1,
              perPage: 20,
            },
          });
        });
        await tab.route("https://cloud.example.test/machine-fixture.js", (route) =>
          route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle }),
        );
        await tab.route("https://cloud.example.test/app/accounts/service-accounts", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<!doctype html><html lang="en" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-theme="${dark ? "dark" : "light"}"><main id="root" class="p-4"></main><script src="/machine-fixture.js"></script></body></html>`,
          }),
        );
        await tab.goto("https://cloud.example.test/app/accounts/service-accounts");
        await tab.getByRole("button", { name: "Directory access", exact: true }).click();
        const dialog = tab.getByRole("dialog");
        await dialog.getByRole("combobox").first().fill("Release");
        await tab.getByRole("option", { name: /Release helper/ }).click();
        await dialog.getByText(/No entries shared/).waitFor();
        await dialog.getByRole("combobox").nth(1).fill("Ada");
        await tab.getByRole("option", { name: /Ada Example/ }).click();
        await dialog.getByText(/Could not update directory access/).waitFor();
        fail = false;
        await dialog.getByRole("button", { name: "Retry", exact: true }).click();
        await dialog.getByRole("button", { name: "Revoke directory access: Ada Example", exact: true }).waitFor();
        expect(writes).toEqual([{ principal: { type: "user", userId: personId } }, { principal: { type: "user", userId: personId } }]);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await dialog.getByRole("button", { name: "Revoke directory access: Ada Example", exact: true }).click();
        await dialog.getByText(/No entries shared/).waitFor();
        await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
        await dialog.waitFor({ state: "hidden" });
        expect(errors).toEqual([]);
      } finally {
        await tab.close();
      }
    });
  }
