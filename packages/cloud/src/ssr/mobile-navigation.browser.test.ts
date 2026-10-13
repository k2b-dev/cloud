import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

const ui = resolve(import.meta.dir, "../../../ui");
let browser: Browser;
let harness: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "mobile-navigation.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "mobile-navigation-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not build the mobile navigation harness");
  harness = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet");
  css = await styles.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

test("the phone menu uses each app's accent for its active row and switcher icon", async () => {
  const colors: string[] = [];
  for (const accent of ["#eab308", "#008f4c"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const html =
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"><script id="cloud-shell-data" type="application/json">${JSON.stringify({ accent })}</script>` +
        '<div id="workspace"></div><span id="fallback" class="app-accent-scope" style="color:var(--ui-app-accent-text)"></span></body></html>';
      await page.route("http://localhost/mobile-navigation", (route) => route.fulfill({ contentType: "text/html", body: html }));
      await page.goto("http://localhost/mobile-navigation");
      await page.addScriptTag({ content: harness });
      await page.getByRole("button", { name: "Open menu", exact: true }).tap();
      await page.locator("dialog .k2b-navigation").waitFor({ state: "visible" });
      const result = await page.evaluate(() => {
        const navigation = document.querySelector("dialog .k2b-navigation")!;
        const scope = navigation.closest<HTMLElement>(".app-accent-scope")!;
        const probe = document.createElement("span");
        probe.style.color = "var(--ui-app-accent-text)";
        scope.append(probe);
        const color = (element: Element) => getComputedStyle(element).color;
        return {
          accent: scope.style.getPropertyValue("--app-accent"),
          canvas: Boolean(scope.closest(".cloud-app-canvas")),
          expected: color(probe),
          fallback: color(document.getElementById("fallback")!),
          active: color(navigation.querySelector('[aria-current="page"] .k2b-navigation__copy > span')!),
          icon: color(navigation.querySelector(".k2b-sidebar-switcher__icon")!),
        };
      });
      expect(result.accent).toBe(accent);
      expect(result.canvas).toBe(false);
      expect(result.active).toBe(result.expected);
      expect(result.icon).toBe(result.expected);
      expect(result.expected).not.toBe(result.fallback);
      colors.push(result.expected);
    } finally {
      await page.close();
    }
  }
  expect(colors[0]).not.toBe(colors[1]);
}, 20_000);
