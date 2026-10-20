import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-activity-steps-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Chat } = await import("../index");
const { ActivityToggleFixture } = await import("../../test/chat-activity-steps.browser-harness");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
// Embed the shipped icon font: geometry must not depend on an external font request.
const icons = readFileSync(resolve(import.meta.dir, "../../dist/tabler.css"), "utf8").replace(
  /url\(([^)]+)\)/g,
  (_, path: string) =>
    `url(data:font/woff2;base64,${readFileSync(resolve(import.meta.dir, "../../dist", path.split("?")[0]!)).toString("base64")})`,
);
let browser: Browser;
let bundle: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chat-activity-steps.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "chat-activity-steps-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Activity steps harness failed");
  bundle = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function content(page: Page, html: string, dark: boolean) {
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}\n${icons}
    html { font-size:16px; } body { margin:0; padding:16px; font-family:Arial,sans-serif; line-height:1.5; }
  </style></head><body class="k2b-ui${dark ? " k2b-dark" : ""}">${html}</body></html>`);
  await settled(page);
}
const activity = (props: Parameters<typeof Chat.Activity>[0]) => renderToString(() => createComponent(Chat.Activity, props));
const fixedBoxes = (page: Page) =>
  page.evaluate(() =>
    ["#above", ".k2b-chat-activity__row"].map((selector) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

for (const dark of [false, true]) {
  const theme = dark ? "dark" : "light";
  test(`only the count toggles; linked chips and everything above stay in place (${theme})`, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
    try {
      await content(page, `<div id="toggle-root">${renderToString(() => createComponent(ActivityToggleFixture, {}))}</div>`, dark);
      expect(await page.locator("summary, details").count()).toBe(0);
      // Use the same component with the Solid DOM transform for event handlers, as in the decision harness.
      await page.locator("#toggle-root").evaluate((root) => root.replaceChildren());
      await page.addScriptTag({ content: bundle });
      await settled(page);
      const row = page.locator(".k2b-chat-activity__row");
      const toggle = row.getByRole("button", { name: "3 of 4 tasks", exact: true });
      expect(await row.evaluate((e) => e.tagName)).toBe("DIV");
      expect(await row.locator("button").count()).toBe(1);
      expect(await page.locator("summary, details").count()).toBe(0);
      expect(await toggle.getAttribute("type")).toBe("button");
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      const body = page.locator(".k2b-chat-activity__body");
      expect(await toggle.getAttribute("aria-controls")).toBe(await body.getAttribute("id"));
      expect(await body.isVisible()).toBe(false);
      const chip = row.getByRole("link", { name: "Team Ops", exact: true });
      expect(await chip.getAttribute("href")).toBe("#chip");
      await chip.click();
      await settled(page);
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await body.isVisible()).toBe(false);
      const geometry = await toggle.evaluate((button) => {
        const words = button.querySelector(".k2b-chat-activity__toggle-label")!;
        const chevron = words.nextElementSibling!;
        const text = words.getBoundingClientRect();
        const icon = chevron.getBoundingClientRect();
        return {
          chevron: chevron.classList.contains("k2b-chat-activity__chevron"),
          width: icon.width,
          gap: icon.left - text.right,
          center: Math.abs(icon.top + icon.height / 2 - text.top - text.height / 2),
        };
      });
      expect(geometry.chevron).toBe(true);
      expect(geometry.width).toBeGreaterThan(0);
      expect(geometry.gap).toBeGreaterThanOrEqual(0);
      expect(geometry.gap).toBeLessThan(4);
      expect(geometry.center).toBeLessThanOrEqual(2);
      const before = await fixedBoxes(page);
      await toggle.click();
      await settled(page);
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      expect(await body.isVisible()).toBe(true);
      expect(await fixedBoxes(page)).toEqual(before);
      await toggle.focus();
      await page.keyboard.press("Enter");
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      expect(await body.isVisible()).toBe(false);
      await page.keyboard.press("Space");
      expect(await toggle.getAttribute("aria-expanded")).toBe("true");
      expect(await body.isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });

  for (const width of [1440, 390]) {
    test(`running to done moves the next row 0px at ${width}px (${theme})`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      try {
        const running = activity({ busy: true, icon: "ti ti-loader-2 k2b-spin", label: "Creating 4 tasks in Team Ops …" });
        const done = activity({ tone: "success", icon: "ti ti-check", label: "Created 4 tasks in Team Ops" });
        await content(page, `${running}<p id="sentinel">Next conversation paragraph</p>`, dark);
        const before = await page.locator("#sentinel").evaluate((e) => e.getBoundingClientRect().y);
        await page.locator(".k2b-chat-activity").evaluate((e, html) => {
          e.outerHTML = html;
        }, done);
        await settled(page);
        expect(await page.locator("#sentinel").evaluate((e) => e.getBoundingClientRect().y)).toBe(before);
      } finally {
        await page.close();
      }
    });
  }

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`busy spinning icon is solid AI accent (${theme}, ${reducedMotion})`, async () => {
      const page = await browser.newPage({ reducedMotion } satisfies BrowserContextOptions);
      try {
        await content(
          page,
          `${activity({ busy: true, icon: "ti ti-loader-2 k2b-spin", label: "Creating tasks" })}<span id="probe" style="color:var(--k2b-ai-accent)">Probe</span>`,
          dark,
        );
        const paint = await page.evaluate(() => {
          const leading = getComputedStyle(document.querySelector(".k2b-chat-activity__leading")!);
          return {
            color: leading.color,
            fill: leading.webkitTextFillColor,
            expected: getComputedStyle(document.getElementById("probe")!).color,
          };
        });
        expect(paint.color).toBe(paint.expected);
        expect(paint.fill).not.toBe("rgba(0, 0, 0, 0)");
        expect(paint.fill).not.toBe("transparent");
        expect(paint.fill).toBe(paint.color);
      } finally {
        await page.close();
      }
    });
  }

  test(`task previews inherit 13px only inside an activity body (${theme})`, async () => {
    const preview = () =>
      createComponent(Chat.Preview, {
        get children() {
          return createComponent(Chat.Preview.Lines, {
            label: "Tasks",
            get children() {
              return [
                createComponent(Chat.Preview.Line, { icon: "ti ti-check", meta: "Created", children: "Check inventory" }),
                createComponent(Chat.Preview.Line, { icon: "ti ti-alert-triangle", tone: "warning", children: "Retry delivery task" }),
              ];
            },
          });
        },
      });
    const page = await browser.newPage();
    try {
      const inside = activity({
        label: "Created tasks",
        defaultOpen: true,
        get children() {
          return preview();
        },
      });
      await content(page, `${inside}<div id="outside">${renderToString(preview)}</div>`, dark);
      for (const [scope, expected] of [
        [".k2b-chat-activity__body", ["13px", "13px", "13px", "13px"]],
        ["#outside", ["14.5px", "14.5px", "13.5px", "13.5px"]],
      ] as const) {
        const sizes = await page
          .locator(`${scope} .k2b-chat-preview, ${scope} .k2b-chat-preview__line, ${scope} .k2b-chat-preview__meta`)
          .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize));
        expect(sizes).toHaveLength(4);
        expect(sizes).toEqual([...expected]);
      }
    } finally {
      await page.close();
    }
  });
}

const longLabel = "Created tasks for the inventory review, delivery planning, and workshop preparation in Team Ops. ".repeat(4);
for (const [width, narrowTimeline] of [
  [390, false],
  [1440, false],
  [1440, true],
] as const) {
  test(`labels wrap only on a narrow surface (${width}px window, narrow timeline: ${narrowTimeline})`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      const row = activity({ label: longLabel, icon: "ti ti-check" });
      // A plain timeline element isolates the CSS container contract from scrolling and message layout.
      await content(page, narrowTimeline ? `<div class="k2b-chat-timeline" style="width:22rem">${row}</div>` : row, false);
      const metrics = await page.locator(".k2b-chat-activity__copy strong").evaluate((label) => {
        const style = getComputedStyle(label);
        return {
          scroll: label.scrollWidth,
          client: label.clientWidth,
          height: label.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(style.lineHeight),
          overflow: style.overflow,
          ellipsis: style.textOverflow,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(metrics.pageOverflow).toBe(0);
      if (width === 390 || narrowTimeline) {
        expect(metrics.scroll).toBe(metrics.client);
        expect(metrics.height).toBeGreaterThan(metrics.lineHeight);
      } else {
        expect(metrics.height).toBe(metrics.lineHeight);
        expect(metrics.scroll).toBeGreaterThan(metrics.client);
        expect(metrics.overflow).toBe("hidden");
        expect(metrics.ellipsis).toBe("ellipsis");
      }
    } finally {
      await page.close();
    }
  });
}
