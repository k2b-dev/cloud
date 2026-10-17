import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const ui = new URL("../../../ui/", import.meta.url).pathname;
let browser: Browser;
let bundle: string;
let css: string;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./chart-tooltips.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pulse-chart-tooltips-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Pulse chart tooltip harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(`${ui}dist/styles.css`).text();
  browser = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await browser?.close();
});

const tooltipText = async (page: Page, chart: string) => {
  const selector = `${chart} [role="tooltip"]:popover-open`;
  await page.waitForFunction((selector) => !!document.querySelector(selector)?.textContent, selector);
  const text = await page.locator(selector).textContent();
  expect(text).not.toMatch(/Value|Wert| X:| Y:/);
  return text;
};

test("public and workspace metric charts show time, units and localized counts on hover and keyboard inspection", async () => {
  // Tall enough that no chart needs scrolling: a scroll closes open chart tooltips by design, and
  // Playwright's scroll-into-view would race the hover that opens the next one.
  const page = await browser.newPage({ viewport: { width: 1280, height: 2400 } });
  try {
    await page.setContent(`<!doctype html><html lang="de"><head><style>${css}
      .k2b-chart { height: 240px; }
      </style></head><body class="k2b-ui"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: bundle });
    const bar = '#public [data-chart-kind="bar"]';
    await page.locator(`${bar} .stdlib-chart-bar`).first().hover();
    const barText = await tooltipText(page, bar);
    expect(barText).toContain("14:00");
    expect(barText).toContain("CPU: 42%");

    await page.mouse.move(0, 0);
    const line = '#public [data-chart-kind="line"]';
    await page.locator(line).focus();
    await page.keyboard.press("Home");
    const lineText = await tooltipText(page, line);
    expect(lineText).toContain("14:00");
    expect(lineText).toContain("CPU: 42%");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");

    const histogram = '#public [data-chart-kind="histogram"]';
    await page.locator(`${histogram} .stdlib-chart-bar`).first().hover();
    expect(await tooltipText(page, histogram)).toContain("Anzahl:");

    const workspace = '#workspace [data-chart-kind="bar"]';
    await page.locator(`${workspace} .stdlib-chart-bar`).first().hover();
    const workspaceText = await tooltipText(page, workspace);
    expect(workspaceText).toContain("14:00");
    expect(workspaceText).toContain("CPU: 42%");
  } finally {
    await page.close();
  }
}, 30_000);
