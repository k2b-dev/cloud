import { afterAll, beforeAll, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";
import { buildOlderGlobal } from "../styles/older-core-global.test-fixture";

// Only on request (`CLOUD_SHOTS=1 bun test <this file>`): the suite skips it.
const shots = process.env.CLOUD_SHOTS !== undefined;

// Design-review images of a visitor page on v2 (not part of the suite; see `shots` below): the k2b-ui public-page recipe in
// `MinimalLayout ui="v2"`, light, real fonts and icons, with Core's v2.css alone; and beside an older Core. PNGs go to
// `public-shots/` at the repository root.
const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-shots-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MinimalLayout } = await import("./MinimalLayout");
const recipe = await import("../../../ui/skills/k2b-ui/recipes/public-page");
type Context = Parameters<typeof MinimalLayout>[0]["c"];
const coreRoutes = spyOn(watcher, "registeredCoreRoutes");

const legalApp = {
  id: "legal",
  legalLinks: [
    { label: "Impressum", href: "/impressum" },
    { label: "Datenschutz", href: "/datenschutz" },
  ],
};
const render = (kiosk: boolean, older: boolean) => {
  coreRoutes.mockReturnValue(older ? ["/public/global.css"] : ["/public/global.css", "/public/v2.css"]);
  const page = {};
  const context = {
    get: (key: string) => (key === "page" ? page : key === "runtime" ? { apps: [legalApp] } : undefined),
    req: { raw: { headers: new Headers({ "Accept-Language": "de" }), url: "https://cloud.test/public/kulturhaus" } },
  } as unknown as Context;
  return renderToString(() =>
    createComponent(MinimalLayout, {
      c: context,
      ui: "v2",
      preferences: !kiosk,
      get children() {
        return createComponent(recipe.default, { kiosk });
      },
    }),
  );
};

const repo = resolve(import.meta.dir, "../../../..");
const ui = resolve(repo, "packages/ui/dist");
const out = resolve(repo, "public-shots");
let browser: Browser;
const sheets = { v2: "", older: "" };
beforeAll(async () => {
  if (!shots) return;
  const v2 = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  if (!v2.success) throw new AggregateError(v2.logs, "Could not build v2.css.");
  sheets.v2 = await v2.outputs[0]!.text();
  sheets.older = await buildOlderGlobal(["./minimal-layout.css"]);
  mkdirSync(out, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  coreRoutes.mockRestore();
});

const fonts = () => {
  const plex = readFileSync(join(ui, "plex.css"), "utf8").replace(/url\(\.\/fonts\/([^)]+)\)/g, (_, file: string) => {
    const data = readFileSync(join(ui, "fonts", file)).toString("base64");
    return `url(data:font/woff2;base64,${data})`;
  });
  const tabler = readFileSync(join(ui, "tabler.css"), "utf8").replace(/url\(\.\/(tabler-icons-[\w]+\.woff2)\)/g, (_, file: string) => {
    const data = readFileSync(join(ui, file)).toString("base64");
    return `url(data:font/woff2;base64,${data})`;
  });
  return plex + tabler;
};

const shoot = async (name: string, width: number, kiosk: boolean, older: boolean) => {
  const phone = width < 768;
  const page = await browser.newPage({
    colorScheme: "light",
    viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
    const body = older ? "k2b-ui" : "k2b-ui k2-ui";
    await page.setContent(
      `<!doctype html><html lang="de" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts()}</style><style>${older ? sheets.older : sheets.v2}</style></head>` +
        `<body class="${body}">${render(kiosk, older)}</body></html>`,
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await settled(page);
    await page.screenshot({ path: join(out, `${name}-light-${width}.png`), fullPage: !kiosk });
  } finally {
    await page.close();
  }
};

for (const width of [1440, 1024, 390]) {
  test.skipIf(!shots)(`visitor ${width}`, () => shoot("01-visitor-page", width, false, false), 60_000);
  test.skipIf(!shots)(`older ${width}`, () => shoot("03-visitor-page-older-core", width, false, true), 60_000);
}
for (const width of [1440, 1024]) test.skipIf(!shots)(`kiosk ${width}`, () => shoot("02-kiosk", width, true, false), 60_000);
