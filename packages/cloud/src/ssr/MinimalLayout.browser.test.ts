import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { type Browser, chromium } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

// Where the footer lands depends on the cascade between Cloud and @k2b/ui
// styles and on the page around it, which only a real engine shows.
const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-layout-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MinimalLayout } = await import("./MinimalLayout");
type MinimalLayoutContextArg = Parameters<typeof MinimalLayout>[0]["c"];

const legalApp = {
  id: "legal-probe",
  legalLinks: [
    { label: "Imprint", href: "/legal/imprint" },
    { label: "Privacy", href: "/legal/privacy" },
  ],
};

const CONTENT = "minimal-layout-probe-content";
const pages = {
  // A public share: one card, no height of its own.
  short: `<main style="width:100%;max-width:42rem;margin:0 auto;padding:2.5rem 1rem"><div style="height:12rem">Card</div></main>`,
  // A centered unlock or error page that fills the space above the footer.
  fill: `<main style="flex:1;display:flex;align-items:center;justify-content:center;padding:2rem 1rem"><div style="width:18rem;height:16rem">Card</div></main>`,
  // A long form.
  long: `<main style="height:2000px">Form</main>`,
  // An app surface such as the Assistant runner that scrolls inside.
  app: `<main style="display:flex;flex:1 1 0;min-height:0;overflow:hidden"><div style="overflow:auto"><div style="height:3000px">Runner</div></div></main>`,
} as const;

const render = (page: keyof typeof pages) => {
  const context = {
    get: (key: string) => (key === "page" ? {} : key === "runtime" ? { apps: [legalApp] } : undefined),
    req: { raw: { headers: new Headers({ "Accept-Language": "en" }), url: "https://cloud.test/share/probe" } },
  } as unknown as MinimalLayoutContextArg;
  return renderToString(() => createComponent(MinimalLayout, { c: context, children: CONTENT })).replace(CONTENT, pages[page]);
};

let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const viewports = [
  { name: "phone", width: 390, height: 664, isMobile: true, hasTouch: true, minTarget: 44 },
  { name: "narrow phone", width: 320, height: 568, isMobile: true, hasTouch: true, minTarget: 44 },
  { name: "desktop", width: 1440, height: 900, isMobile: false, hasTouch: false, minTarget: 28 },
] as const;

const measure = async (viewport: (typeof viewports)[number], page: keyof typeof pages) => {
  const tab = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
  });
  try {
    await tab.setContent(
      `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui">${render(page)}</body></html>`,
    );
    return await tab.evaluate(() => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const footer = document.querySelector("footer")!;
      // The closed language menu is rendered but hidden.
      const visible = Array.from(footer.querySelectorAll("a[href], button")).filter((control) => control.checkVisibility());
      const controls = visible.map((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          name: control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "",
          box: box(control),
          reachable: hit === control || control.contains(hit),
        };
      });
      return {
        footer: box(footer),
        main: box(document.querySelector("main")!),
        controls,
        position: getComputedStyle(footer).position,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  } finally {
    await tab.close();
  }
};

describe("MinimalLayout footer in a browser", () => {
  for (const viewport of viewports) {
    test(`stays in flow, inside the viewport, and finger-sized on ${viewport.name}`, async () => {
      for (const page of ["short", "fill", "long", "app"] as const) {
        const { footer, main, controls, position, scrollWidth } = await measure(viewport, page);
        const context = `${viewport.name} ${page}`;

        expect(position, context).toBe("static");
        expect(scrollWidth, context).toBeLessThanOrEqual(viewport.width);
        expect(footer.left, context).toBeGreaterThanOrEqual(0);
        expect(footer.right, context).toBeLessThanOrEqual(viewport.width);
        // The footer follows the content and never covers it.
        expect(footer.top, context).toBeGreaterThanOrEqual(main.bottom - 0.5);
        if (page === "long") expect(footer.top, context).toBeGreaterThanOrEqual(2000);
        // Other pages end with the footer at the bottom of the first screen.
        else expect(Math.abs(footer.bottom - viewport.height), context).toBeLessThan(1);

        expect(controls.map((control) => control.name)).toEqual(["Imprint", "Privacy", "Language: English", "Dark mode"]);
        for (const control of controls) {
          const name = `${context} ${control.name}`;
          expect(control.box.left, name).toBeGreaterThanOrEqual(0);
          expect(control.box.right, name).toBeLessThanOrEqual(viewport.width);
          expect(control.box.height, name).toBeGreaterThanOrEqual(viewport.minTarget);
          if (page !== "long") expect(control.reachable, name).toBe(true);
        }
        for (const [index, a] of controls.entries()) {
          for (const b of controls.slice(index + 1)) {
            const overlap =
              Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 0.5 &&
              Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 0.5;
            expect(overlap, `${context} ${a.name} / ${b.name}`).toBe(false);
          }
        }
      }
    }, 30_000);
  }
});
