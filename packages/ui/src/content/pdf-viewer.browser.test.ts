import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { pdfFixture } from "../../test/pdf-fixture";

// pdf.js draws real pages only in a real browser, so the shipped browser build renders a generated 40-page PDF here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const origin = "http://k2b-ui.test/";
const entry = resolve(import.meta.dir, "pdf-viewer.fixture.ts");
const directory = mkdtempSync(join(tmpdir(), "k2b-pdf-viewer-"));
const result = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
    import { createComponent, render } from "solid-js/web";
    import { PdfViewer } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
    const data = await (await fetch("/doc.pdf")).arrayBuffer();
    window.pdfErrors = [];
    render(() => createComponent(PdfViewer, { data, title: "Fixture", onError: (error) => window.pdfErrors.push(String(error)) }), document.getElementById("app"));
  `,
  },
  target: "browser",
  format: "esm",
  splitting: true,
  metafile: true,
  outdir: directory,
  // The naming @k2b/ssr uses, so the worker asset lands next to the chunks as it does in an app.
  naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
});
if (!result.success || !result.metafile) throw new AggregateError(result.logs, "Could not build the PdfViewer fixture");
const assets = new Map(
  await Promise.all(result.outputs.map(async (output) => [basename(output.path), await output.arrayBuffer()] as const)),
);
const pdf = pdfFixture(40, 7);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
});

const load = async (): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.route(`${origin}**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "doc.pdf") return route.fulfill({ body: Buffer.from(pdf), contentType: "application/pdf" });
    const asset = assets.get(path);
    if (asset) return route.fulfill({ body: Buffer.from(asset), contentType: path.endsWith(".js") ? "text/javascript" : undefined });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><style>${css}</style><style>body{margin:0}#app{height:100vh;display:flex;flex-direction:column}</style></head><body class="k2b-ui"><main id="app"></main><script type="module" src="/entry.js"></script></body></html>`,
    });
  });
  await page.goto(origin);
  await page.locator('[data-pdf-page="0"] img').waitFor();
  return page;
};

describe("@k2b/ui PdfViewer", () => {
  test("pdf.js never enters a host's bundle: the engine and its worker arrive as files", () => {
    const bundled = Object.values(result.metafile!.outputs).some((output) =>
      Object.keys(output.inputs).some((path) => path.includes("pdfjs-dist")),
    );
    expect(bundled).toBe(false);
    const files = [...assets.keys()];
    expect(files.some((file) => file.startsWith("pdf-viewer-engine"))).toBe(true);
    expect(files.some((file) => file.startsWith("pdf-viewer-worker"))).toBe(true);
  });

  test("keeps every page's box, draws only pages near the view, and lays their text over them", async () => {
    const page = await load();
    try {
      await settled(page);
      const state = await page.evaluate(() => ({
        boxes: document.querySelectorAll("[data-pdf-page]").length,
        images: document.querySelectorAll("[data-pdf-page] img").length,
        landscapeWider: (() => {
          const portrait = document.querySelector<HTMLElement>('[data-pdf-page="0"]')!.getBoundingClientRect();
          const landscape = document.querySelector<HTMLElement>('[data-pdf-page="6"]')!.getBoundingClientRect();
          return Math.round(landscape.width) === Math.round(portrait.width) && landscape.height < portrait.height;
        })(),
        errors: (window as unknown as { pdfErrors: string[] }).pdfErrors,
      }));
      expect(state.boxes).toBe(40);
      expect(state.images).toBeGreaterThan(0);
      expect(state.images).toBeLessThan(15);
      // Fitted to the width, a landscape page is as wide as a portrait one and shorter.
      expect(state.landscapeWider).toBe(true);
      expect(state.errors).toEqual([]);
      await page.waitForFunction(() =>
        document.querySelector('[data-pdf-page="0"] .k2b-pdf-viewer__text')?.textContent?.includes("Page 1"),
      );
    } finally {
      await page.close();
    }
  });

  test("scrolling to the end draws the last page and shows it as the current one", async () => {
    const page = await load();
    try {
      await page.locator(".k2b-pdf-viewer__pages").evaluate((area) => area.scrollTo({ top: area.scrollHeight }));
      await page.locator('[data-pdf-page="39"] img').waitFor();
      await page.waitForFunction(() => document.querySelector(".k2b-pdf-viewer__page-number")?.textContent?.includes("40 / 40"));
      expect(await page.locator('[data-pdf-page="0"] .k2b-pdf-viewer__text').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  test("zooms in steps, with Ctrl and the wheel, and back to the width", async () => {
    const page = await load();
    try {
      const pages = page.locator(".k2b-pdf-viewer__pages");
      expect(await pages.getAttribute("data-fit")).toBe("");
      const fitted = Number(await pages.getAttribute("data-zoom"));
      await page.getByRole("button", { name: "Zoom in" }).click();
      await settled(page);
      const stepped = Number(await pages.getAttribute("data-zoom"));
      expect(stepped).toBeGreaterThan(fitted);
      expect([25, 50, 75, 100, 125, 150, 200, 300]).toContain(stepped);
      expect(await pages.getAttribute("data-fit")).toBeNull();
      const box = (await pages.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 120);
      await page.keyboard.up("Control");
      await settled(page);
      expect(Number(await pages.getAttribute("data-zoom"))).toBeLessThan(stepped);
      await page.getByRole("button", { name: "Fit to width" }).click();
      await settled(page);
      expect(await pages.getAttribute("data-fit")).toBe("");
      expect(Number(await pages.getAttribute("data-zoom"))).toBe(fitted);
    } finally {
      await page.close();
    }
  });
});
