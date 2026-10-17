import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { browserName, launchBrowser } from "../../../ui/test/browser";

const root = mkdtempSync(resolve(tmpdir(), "cloud-print-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const { Hono } = await import("hono");
const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const railSnapshot = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { default: Layout } = await import("./Layout");
const { PrintWorkspace } = await import("./print.test-fixture");
const probe = defineApp({
  id: "print-probe",
  name: "Print probe",
  icon: "ti ti-printer",
  description: "Invented print fixture",
  baseUrl: "http://print-probe:3000",
  routes: ["/app/print"],
});
const server = new Hono().get(
  "/app/print",
  async (c, next) => {
    c.set("user" as never, person as never);
    c.set(
      "runtime" as never,
      {
        apps: [
          {
            id: "print-probe",
            name: "Print probe",
            icon: "ti ti-printer",
            description: "Print fixture",
            routes: ["/app/print"],
            nav: { href: "/app/print", section: "primary" },
          },
        ],
      } as never,
    );
    await next();
  },
  ...probe.ssr(
    (c) => () =>
      createComponent(Layout, {
        c,
        fullPage: true,
        fullWidth: true,
        focusMode: c.req.query("focus") === "true",
        title: [{ title: "Start", href: "/" }, { title: "Print probe", href: "/app/print" }, { title: "Field notes" }],
        printHint: c.req.query("hint"),
        get children() {
          return createComponent(PrintWorkspace, { region: c.req.query("region") !== "false" });
        },
      }),
  ),
);
let browser: Browser;
let css: string;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  );
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Global print fixture CSS");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  spies.forEach((spy) => spy.mockRestore());
  await browser?.close();
});
async function open(query = "", locale = "en", theme: "light" | "dark" = "light") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  try {
    const html = await (
      await server.request(`/app/print?${query}`, { headers: { "Accept-Language": locale, Cookie: `theme=${theme}` } })
    ).text();
    await page.setContent(html.replace("</head>", `<style>${css}</style></head>`));
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}
const hidden = async (page: Page, selector: string) => {
  expect(await page.locator(selector).count()).toBeGreaterThan(0);
  for (const element of await page.locator(selector).all()) expect(await element.boundingBox()).toBeNull();
};
const chrome = ".layout-rail,.layout-header,.layout-page-head,.k2b-app-workspace__sidebar,.k2b-app-workspace__detail";

test("only regions print, with all 120 paragraphs and unclipped ancestors", async () => {
  const page = await open();
  try {
    await page.emulateMedia({ media: "print" });
    for (const selector of [
      ".layout-rail",
      ".layout-header",
      ".layout-page-head",
      ".k2b-app-workspace__sidebar",
      ".k2b-app-workspace__detail",
      "#outside-heading",
      "[data-print-fallback]",
    ])
      await hidden(page, selector);
    const boxes = await page.locator(".print-paragraph").evaluateAll((elements) =>
      elements.map((e) => {
        const r = e.getBoundingClientRect();
        return { width: r.width, height: r.height, top: r.top };
      }),
    );
    expect(boxes).toHaveLength(120);
    expect(boxes.every((box) => box.width > 0 && box.height > 0)).toBe(true);
    expect(boxes.at(-1)!.top).toBeGreaterThan(900);
    expect(
      await page.locator("[data-print-region]").evaluate((region) => {
        const height = region.getBoundingClientRect().height;
        const failures: string[] = [];
        for (let ancestor = region.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.overflowX !== "visible" || style.overflowY !== "visible" || ancestor.getBoundingClientRect().height + 1 < height)
            failures.push(`${ancestor.className}: ${style.overflow}, ${style.height}`);
        }
        return failures;
      }),
    ).toEqual([]);
    expect(await page.locator("[data-print-region] .k2b-scroll-area").evaluate((el) => getComputedStyle(el).overflowY)).toBe("visible");
    // No element between the last paragraph and the page clips it.
    expect(
      await page
        .locator(".print-paragraph")
        .last()
        .evaluate((paragraph) => {
          const box = paragraph.getBoundingClientRect();
          const clips: string[] = [];
          for (let ancestor = paragraph.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            const frame = ancestor.getBoundingClientRect();
            if (box.top < frame.top - 1 || box.bottom > frame.bottom + 1) clips.push(`${ancestor.tagName}.${ancestor.className}`);
          }
          return clips;
        }),
    ).toEqual([]);
    if (browserName === "chromium") {
      const pdf = await page.pdf({ format: "A4" });
      const pages = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? [];
      expect(pages.length).toBeGreaterThan(1);
    }
  } finally {
    await page.close();
  }
});

for (const locale of ["en", "de"])
  for (const custom of [false, true])
    for (const focus of [false, true]) {
      test(`${locale}: ${focus ? "focus" : "regular"} fallback with ${custom ? "app" : "default"} hint`, async () => {
        const hint = locale === "de" ? "Lade das PDF herunter." : "Download the PDF.";
        const page = await open(`region=false&focus=${focus}${custom ? `&hint=${encodeURIComponent(hint)}` : ""}`, locale);
        try {
          await page.emulateMedia({ media: "print" });
          await hidden(page, ".k2b-app-workspace");
          expect(await page.locator("[data-print-fallback]").boundingBox()).not.toBeNull();
          expect(await page.locator("[data-print-fallback] p").allTextContents()).toEqual([
            locale === "de" ? "Diese Ansicht lässt sich nicht gut drucken." : "This view does not print well.",
            custom
              ? hint
              : locale === "de"
                ? "Öffne den Eintrag, den du drucken möchtest, oder nutze den Export der App."
                : "Open the item you want to print, or use the app's export.",
          ]);
        } finally {
          await page.close();
        }
      });
    }
for (const region of [true, false])
  test(`dark cookie prints ${region ? "region" : "fallback"} as ink`, async () => {
    const page = await open(`region=${region}`, "en", "dark");
    try {
      expect(await page.locator("html").getAttribute("class")).toContain("dark");
      await page.emulateMedia({ media: "print" });
      const target = page.locator(region ? ".print-paragraph" : "[data-print-fallback] p").first();
      expect(await target.boundingBox()).not.toBeNull();
      expect(await target.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(9, 9, 11)");
    } finally {
      await page.close();
    }
  });
test("region and fallback markup leave the screen geometry unchanged", async () => {
  const pages = [await open(), await open("region=false")];
  try {
    const boxes = [];
    for (const page of pages) {
      await page.emulateMedia({ media: "screen" });
      await hidden(page, "[data-print-fallback]");
      boxes.push(
        await page.locator(`${chrome},.k2b-app-workspace__main`).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON())),
      );
    }
    expect(boxes[0]).toEqual(boxes[1]);
  } finally {
    await Promise.all(pages.map((page) => page.close()));
  }
});
