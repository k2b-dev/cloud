import { afterAll, beforeAll, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { html, installCompactShellHarness } from "../ssr/compact-shell.browser-harness";

// Design-review images of the v2 access dialog (not part of the suite; see `shots` below): the dialog over a real Cloud
// page with its shell (rail, header, the app's card), German, light, IBM Plex and Tabler icons, invented people. A
// notebook's dialog in each state, the base view of a space, its read-only view and the worst case, at 1440 and 390 px.
// Run with CLOUD_SHOTS=<folder>.
const shots = process.env.CLOUD_SHOTS;
const ui = resolve(import.meta.dir, "../../../ui");
const dist = join(ui, "dist");
const origin = "https://cloud.example.test";
/** An invented installation's logo. */
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="5" fill="#9a3412"/><text x="10" y="14.5" font-family="sans-serif" font-size="12" font-weight="600" text-anchor="middle" fill="#fff">L</text></svg>';

installCompactShellHarness(launchBrowser);

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AccessDialogV2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-sharing-v2-shots",
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
  if (!build.success) throw new AggregateError(build.logs, "Sharing v2 harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let harness: string;
beforeAll(async () => {
  if (!shots) return;
  harness = await buildHarness();
  mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** A Cloud page with its shell behind the dialog, with the page's fonts and icons, and the dialog's harness. */
const open = async (width: number, query: string) => {
  const phone = width < 768;
  const page = await browser.newPage({
    colorScheme: "light",
    viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const shell = (await html("/app/mail/inbox", { language: "de" }))
    .replace("</head>", `<link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"></head>`)
    .replace("</body>", `<script src="/harness.js"></script></body>`);
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/share") return route.fulfill({ contentType: "text/html; charset=utf-8", body: shell });
    if (url.pathname === "/branding/logo") return route.fulfill({ contentType: "image/svg+xml", body: LOGO });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/public/fonts.css") return route.fulfill({ contentType: "text/css", body: readFileSync(join(dist, "plex.css")) });
    if (url.pathname === "/public/tabler-icons.css")
      return route.fulfill({ contentType: "text/css", body: readFileSync(join(dist, "tabler.css")) });
    if (url.pathname.startsWith("/public/fonts/"))
      return route.fulfill({ contentType: "font/woff2", body: readFileSync(join(dist, "fonts", url.pathname.slice(14))) });
    if (/^\/public\/tabler-icons-[\w]+\.woff2$/.test(url.pathname))
      return route.fulfill({ contentType: "font/woff2", body: readFileSync(join(dist, url.pathname.slice(8))) });
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${origin}/share${query}`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await settled(page);
  return { page, dialog };
};

const shoot = async (page: Page, name: string) => {
  await page.mouse.move(0, 0);
  await settled(page);
  await page.screenshot({ path: join(shots!, `${name}.png`) });
};

for (const width of [1440, 390]) {
  test.skipIf(!shots)(
    `notebook ${width}`,
    async () => {
      const { page, dialog } = await open(width, "?notebook&de");
      try {
        await dialog.getByText("Mia Hoffmann").first().waitFor();
        await shoot(page, `01-notebook-${width}`);
        await dialog.getByRole("searchbox").fill("zz");
        await dialog.getByText("Niemand heißt", { exact: false }).waitFor();
        await shoot(page, `02-notebook-nobody-${width}`);
        await dialog.getByRole("searchbox").fill("noah");
        await dialog.getByText("Noah Becker").first().waitFor();
        await shoot(page, `03-notebook-search-${width}`);
        await dialog.getByRole("button", { name: /Hinzufügen: Noah Becker/ }).click();
        const services = dialog.getByRole("region", { name: /Dienstkonten/ });
        await services.getByRole("button", { name: "Dienstkonto hinzufügen" }).click();
        const handle = services.getByRole("textbox", { name: "Kennung des Dienstkontos" });
        await handle.fill("code-7k2q9m4xwt");
        await handle.press("Enter");
        await services.getByText("Code von Protokolle Vorstand").waitFor();
        await shoot(page, `04-notebook-handle-${width}`);
        await services.getByRole("button", { name: "Dienstkonto hinzufügen" }).click();
        await dialog.getByRole("region", { name: /Was sich ändert/ }).waitFor();
        await shoot(page, `05-notebook-staged-${width}`);
      } finally {
        await page.close();
      }
    },
    60_000,
  );
  for (const [name, query] of [
    ["06-space", "?de"],
    ["07-space-readonly", "?de&readonly"],
    ["08-space-public", "?de&public"],
    ["09-worst", "?de&worst"],
  ] as const)
    test.skipIf(!shots)(
      `${name} ${width}`,
      async () => {
        const { page, dialog } = await open(width, query);
        try {
          await dialog.getByText("Mia Hoffmann").first().waitFor();
          if (query.includes("public")) {
            await dialog.getByRole("switch", { name: /Öffentlich/ }).check({ force: true });
            await dialog.getByText("https://cloud.example.org/s/lager-nord").waitFor();
          }
          await shoot(page, `${name}-${width}`);
        } finally {
          await page.close();
        }
      },
      60_000,
    );
}
