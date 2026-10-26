import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, ConsoleMessage } from "playwright";
import { launchBrowser, pageErrors } from "../../test/browser";

// Keep the same lazy label (the array is a JSX fragment) on the server and in
// the browser: resolving its Toggle must choose the row before hydration starts.
const activities = `
import { createComponent } from "solid-js";
const toggleActivity = (defaultOpen) => createComponent(Chat.Activity, {
  tone: "warning",
  icon: "ti ti-alert-triangle",
  defaultOpen,
  get label() {
    return [
      createComponent(Chat.Activity.Toggle, { children: "3 of 4 tasks" }),
      " created in ",
      createComponent(ReferenceChip, { kind: "place", title: "Team Ops", href: "#chip" }),
    ];
  },
  children: "Three tasks created.",
});
function Activities() {
  return [
    toggleActivity(false),
    toggleActivity(true),
    createComponent(Chat.Activity, { label: "Worked", children: "Steps" }),
  ];
}
`;

// As in help-blocks.browser.test.ts, use an isolated hydratable SSR build;
// the unit harness's process-wide loader compiles without hydration keys.
const serverEntry = resolve(import.meta.dir, "chat-activity-hydration.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `
import { Chat, ReferenceChip } from "../index";
import { generateHydrationScript, renderToString } from "solid-js/web";
${activities}
export const html = renderToString(() => createComponent(Activities, {}));
export const hydrationScript = generateHydrationScript();
`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "chat-activity-hydration-ssr",
      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
          });
          if (!result?.code) throw new Error(`Could not compile ${path}`);
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the activity server fixture");
const serverDir = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-activity-hydration-"));
process.once("exit", () => rmSync(serverDir, { recursive: true, force: true }));
const serverModule = resolve(serverDir, "server.mjs");
writeFileSync(serverModule, await serverBuild.outputs[0]!.text());
const { html, hydrationScript }: { html: string; hydrationScript: string } = await import(serverModule);
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const icons = readFileSync(resolve(import.meta.dir, "../../dist/tabler.css"), "utf8").replace(
  /url\(\.\/([^)?]+)(?:\?[^)]*)?\)/g,
  (_match: string, file: string) =>
    `url(data:font/woff2;base64,${readFileSync(resolve(import.meta.dir, "../../dist", file)).toString("base64")})`,
);
const browserEntry = resolve(import.meta.dir, "../../dist/browser/index.js");
const fixturePath = resolve(import.meta.dir, "chat-activity-hydration.fixture.ts");
const fixture = `
import { Chat, ReferenceChip } from ${JSON.stringify(browserEntry)};
import { hydrate } from "solid-js/web";
${activities}
const root = document.getElementById("app");
const selector = "#above, .k2b-chat-activity, .k2b-chat-activity__row, .k2b-chat-activity__body";
const serverNodes = [...document.querySelectorAll(selector)];
serverNodes.forEach((node, index) => { node.__activityHydrationIndex = index; });
const snapshot = () => {
  const nodes = [...document.querySelectorAll(selector)];
  return {
    reused: nodes.length === serverNodes.length && nodes.every((node, index) =>
      node === serverNodes[index] && node.__activityHydrationIndex === index),
    boxes: nodes.map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }),
  };
};
document.body.dataset.before = JSON.stringify(snapshot());
hydrate(() => createComponent(Activities, {}), root);
document.body.dataset.after = JSON.stringify(snapshot());
requestAnimationFrame(() => {
  document.body.dataset.frame = JSON.stringify(snapshot());
  document.body.dataset.ready = "true";
});
`;
const build = await Bun.build({ entrypoints: [fixturePath], files: { [fixturePath]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the activity hydration fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

test("activity hydration preserves server rows and boxes, then both disclosure forms work", async () => {
  const page = await browser.newPage({ colorScheme: "light", viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error" || /hydrat/i.test(message.text())) errors.push(message.text());
  };
  page.on("console", onConsole);
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><style>${css}${icons}
      html { font-size:16px; } body { margin:0; padding:16px; font-family:Arial,sans-serif; line-height:1.5; }
      </style></head><body class="k2b-ui" data-theme="light"><p id="above">Earlier conversation</p><div id="app">${html}</div>${hydrationScript}</body></html>`);
    // Measure the real icon glyph from the first snapshot, without network or font-swap timing.
    expect(
      await page.evaluate(async () => {
        await document.fonts.load('16px "tabler-icons"');
        await document.fonts.ready;
        return document.fonts.check('16px "tabler-icons"');
      }),
    ).toBe(true);

    const rows = page.locator(".k2b-chat-activity__row");
    const bodies = page.locator(".k2b-chat-activity__body");
    const activities = page.locator(".k2b-chat-activity");
    // These assertions inspect the server HTML before the hydration bundle runs.
    expect(await activities.evaluateAll((nodes) => nodes.map((node) => node.tagName))).toEqual(["DIV", "DIV", "DETAILS"]);
    expect(await rows.evaluateAll((nodes) => nodes.map((node) => node.tagName))).toEqual(["DIV", "DIV", "SUMMARY"]);
    expect(await activities.nth(0).locator("details, summary").count()).toBe(0);
    expect(await activities.nth(1).locator("details, summary").count()).toBe(0);
    expect(await page.locator("details").count()).toBe(1);
    expect(await bodies.count()).toBe(3);
    expect(await bodies.nth(0).isVisible()).toBe(false);
    expect(await bodies.nth(1).isVisible()).toBe(true);
    expect(await bodies.nth(2).isVisible()).toBe(false);

    await page.addScriptTag({ content: script });
    await page.waitForSelector('body[data-ready="true"]');
    const snapshots = await page.locator("body").evaluate((body) => ({
      before: JSON.parse(body.dataset.before!),
      after: JSON.parse(body.dataset.after!),
      frame: JSON.parse(body.dataset.frame!),
    }));
    expect(snapshots.before.boxes).toHaveLength(10);
    expect(snapshots.before.reused).toBe(true);
    expect(snapshots.after).toEqual(snapshots.before);
    expect(snapshots.frame).toEqual(snapshots.before);
    expect(errors).toEqual([]);

    const first = rows.nth(0).getByRole("button", { name: "3 of 4 tasks", exact: true });
    const second = rows.nth(1).getByRole("button", { name: "3 of 4 tasks", exact: true });
    expect(await first.getAttribute("aria-expanded")).toBe("false");
    expect(await second.getAttribute("aria-expanded")).toBe("true");
    expect(await first.getAttribute("aria-controls")).toBe(await bodies.nth(0).getAttribute("id"));
    expect(await second.getAttribute("aria-controls")).toBe(await bodies.nth(1).getAttribute("id"));
    await first.click();
    expect(await first.getAttribute("aria-expanded")).toBe("true");
    expect(await bodies.nth(0).isVisible()).toBe(true);
    await second.click();
    expect(await second.getAttribute("aria-expanded")).toBe("false");
    expect(await bodies.nth(1).isVisible()).toBe(false);
    await rows.nth(2).click();
    expect(await activities.nth(2).evaluate((node) => node.hasAttribute("open"))).toBe(true);
    expect(await bodies.nth(2).isVisible()).toBe(true);
    // Flush the native details toggle event before checking all browser errors.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(errors).toEqual([]);
  } finally {
    page.off("console", onConsole);
    await page.close();
  }
});
