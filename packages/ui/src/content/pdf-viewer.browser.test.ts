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
    const short = await (await fetch("/short.pdf")).arrayBuffer();
    import { createSignal, mergeProps } from "solid-js";
    window.pdfErrors = [];
    const [shown, setShown] = createSignal(data);
    // A document of the same shape again, as regenerating a report does; the caller's buffer stays usable.
    window.pdfReplace = () => setShown(data.slice(0));
    // Another document: "short" has 3 pages instead of 40.
    window.pdfShow = (name) => setShown((name === "short" ? short : data).slice(0));
    window.pdfBufferIntact = () => data.byteLength > 0;
    // "?request" loads through \`request\`: each call waits until the test answers it with a document or a failure.
    window.pdfPending = [];
    const ask = () => () => new Promise((resolve) => window.pdfPending.push(resolve));
    const [request, setRequest] = createSignal(ask());
    window.pdfNewRequest = () => setRequest(() => ask());
    window.pdfAnswer = (index, kind) =>
      window.pdfPending[index](kind === "fail"
        ? Response.json({ message: "The report could not be generated" }, { status: 500 })
        : new Blob([(kind === "short" ? short : data).slice(0)], { type: "application/pdf" }));
    // "?fit=page&height=416" shows the viewer as a short preview beside other content.
    const query = new URLSearchParams(location.search);
    const app = document.getElementById("app");
    if (query.get("height")) app.style.height = query.get("height") + "px";
    const source = query.has("request")
      ? { get request() { return request(); }, autoLoad: true }
      : { get data() { return shown(); } };
    render(() => createComponent(PdfViewer, mergeProps(source, { title: "Fixture", fit: query.get("fit") ?? undefined, open: query.has("open") || undefined, zoom: query.get("zoom") === "0" ? false : undefined, onError: (error) => window.pdfErrors.push(String(error)) })), app);
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
const shortPdf = pdfFixture(3);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
});

const load = async (search = "", viewport = { width: 1000, height: 800 }, drawn = true): Promise<Page> => {
  const page = await browser.newPage({ viewport });
  await page.route(`${origin}**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "doc.pdf") return route.fulfill({ body: Buffer.from(pdf), contentType: "application/pdf" });
    if (path === "short.pdf") return route.fulfill({ body: Buffer.from(shortPdf), contentType: "application/pdf" });
    const asset = assets.get(path);
    if (asset) return route.fulfill({ body: Buffer.from(asset), contentType: path.endsWith(".js") ? "text/javascript" : undefined });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><style>${css}</style><style>body{margin:0}#app{height:100vh;display:flex;flex-direction:column}</style></head><body class="k2b-ui"><main id="app"></main><script type="module" src="/entry.js"></script></body></html>`,
    });
  });
  await page.goto(`${origin}${search}`);
  await page.waitForFunction(() => "pdfAnswer" in window);
  if (drawn) await page.locator('[data-pdf-page="0"] img').waitFor();
  return page;
};

type Frames = { blank: number; placeholder: number; busy: number; boxes: number[] };

/**
 * Samples every frame from now on: frames where page `index` (default: every drawn page) shows no image, where a
 * placeholder covers the pages, where the viewer is busy, and each distinct number of page boxes.
 */
const watchFrames = (page: Page, index?: string) =>
  page.evaluate((watched) => {
    const frames = { blank: 0, placeholder: 0, busy: 0, boxes: [] as number[] };
    Object.assign(window, { pdfFrames: frames });
    const sample = () => {
      const boxes = document.querySelectorAll("[data-pdf-page]");
      const images = document.querySelectorAll(watched === null ? "[data-pdf-page] img" : `[data-pdf-page="${watched}"] img`);
      if (images.length === 0) frames.blank++;
      if (document.querySelector(".k2b-pdf-viewer__placeholder")) frames.placeholder++;
      if (document.querySelector(".k2b-pdf-viewer[aria-busy]")) frames.busy++;
      if (frames.boxes.at(-1) !== boxes.length) frames.boxes.push(boxes.length);
      requestAnimationFrame(sample);
    };
    sample();
  }, index ?? null);
const framesSeen = (page: Page): Promise<Frames> => page.evaluate(() => (window as unknown as { pdfFrames: Frames }).pdfFrames);

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

  test("a new document of the same shape draws again and leaves the caller's bytes usable", async () => {
    const page = await load();
    try {
      const before = await page.locator('[data-pdf-page="0"] img').getAttribute("src");
      await page.evaluate(() => (window as unknown as { pdfReplace: () => void }).pdfReplace());
      await page.waitForFunction((previous) => {
        const src = document.querySelector('[data-pdf-page="0"] img')?.getAttribute("src");
        return Boolean(src && src !== previous);
      }, before);
      expect(await page.evaluate(() => (window as unknown as { pdfBufferIntact: () => boolean }).pdfBufferIntact())).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { pdfErrors: string[] }).pdfErrors)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a regenerated document keeps the drawn pages, zoom, and scroll position until its own pages are drawn", async () => {
    const page = await load();
    try {
      await settled(page);
      await page.getByRole("button", { name: "Zoom in" }).click();
      await settled(page);
      const pages = page.locator(".k2b-pdf-viewer__pages");
      await pages.evaluate((area) => area.scrollTo({ top: area.scrollHeight / 4 }));
      await settled(page);
      const before = await pages.evaluate((area) => ({ top: area.scrollTop, zoom: area.dataset.zoom }));
      const current = await page.locator(".k2b-pdf-viewer__page-number [aria-hidden]").textContent();
      const visible = await page.evaluate(() => {
        const area = document.querySelector(".k2b-pdf-viewer__pages")!.getBoundingClientRect();
        const middle = area.top + area.height / 2;
        return [...document.querySelectorAll<HTMLElement>("[data-pdf-page]")].find((box) => box.getBoundingClientRect().bottom >= middle)!
          .dataset.pdfPage;
      });
      const old = await page.locator(`[data-pdf-page="${visible}"] img`).getAttribute("src");
      await watchFrames(page, visible!);
      await page.evaluate(() => (window as unknown as { pdfReplace: () => void }).pdfReplace());
      await page.waitForFunction(
        ([index, previous]) => {
          const src = document.querySelector(`[data-pdf-page="${index}"] img`)?.getAttribute("src");
          return Boolean(src && src !== previous);
        },
        [visible, old] as const,
      );
      const frames = await framesSeen(page);
      expect(frames.blank).toBe(0);
      expect(frames.placeholder).toBe(0);
      expect(frames.busy).toBeGreaterThan(0);
      expect(await pages.evaluate((area) => ({ top: area.scrollTop, zoom: area.dataset.zoom }))).toEqual(before);
      expect(await page.locator(".k2b-pdf-viewer__page-number [aria-hidden]").textContent()).toBe(current);
      expect(await page.locator(".k2b-pdf-viewer").getAttribute("aria-busy")).toBeNull();
      expect(await page.evaluate(() => (window as unknown as { pdfErrors: string[] }).pdfErrors)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("another document replaces the pages in one step and starts at its top", async () => {
    const page = await load();
    try {
      await settled(page);
      const pages = page.locator(".k2b-pdf-viewer__pages");
      await pages.evaluate((area) => area.scrollTo({ top: area.scrollHeight / 2 }));
      await settled(page);
      await watchFrames(page);
      await page.evaluate(() => (window as unknown as { pdfShow: (name: string) => void }).pdfShow("short"));
      await page.waitForFunction(() => document.querySelectorAll("[data-pdf-page]").length === 3);
      await page.locator('[data-pdf-page="0"] img').waitFor();
      const frames = await framesSeen(page);
      expect(frames.blank).toBe(0);
      expect(frames.placeholder).toBe(0);
      expect(await pages.evaluate((area) => area.scrollTop)).toBe(0);
      await page.waitForFunction(() => document.querySelector(".k2b-pdf-viewer__page-number")?.textContent?.includes("1 / 3"));
      expect(await page.evaluate(() => (window as unknown as { pdfErrors: string[] }).pdfErrors)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("of two documents in a row only the last one shows", async () => {
    const page = await load();
    try {
      await settled(page);
      await watchFrames(page);
      await page.evaluate(() => {
        const show = (window as unknown as { pdfShow: (name: string) => void }).pdfShow;
        show("short");
        show("long");
      });
      await page.waitForFunction(() => !document.querySelector(".k2b-pdf-viewer")?.hasAttribute("aria-busy"));
      await settled(page);
      const frames = await framesSeen(page);
      expect(frames.boxes).toEqual([40]);
      expect(frames.blank).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { pdfErrors: string[] }).pdfErrors)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a slow new request shows a quiet line after a short wait, busy and without moving the pages", async () => {
    const page = await load("?request", undefined, false);
    try {
      await page.evaluate(() => (window as unknown as { pdfAnswer: (index: number, kind: string) => void }).pdfAnswer(0, "long"));
      await page.locator('[data-pdf-page="0"] img').waitFor();
      await settled(page);
      const viewer = page.locator(".k2b-pdf-viewer");
      const box = await page.locator('[data-pdf-page="0"]').boundingBox();
      await page.evaluate(() => (window as unknown as { pdfNewRequest: () => void }).pdfNewRequest());
      expect(await viewer.getAttribute("aria-busy")).toBe("true");
      expect(await page.locator(".k2b-pdf-viewer__progress").count()).toBe(0);
      await page.locator(".k2b-pdf-viewer__progress").waitFor();
      expect(await viewer.getAttribute("data-state")).toBe("shown");
      expect(await page.locator('[data-pdf-page="0"]').boundingBox()).toEqual(box);
      await page.evaluate(() => (window as unknown as { pdfAnswer: (index: number, kind: string) => void }).pdfAnswer(1, "long"));
      await page.waitForFunction(() => !document.querySelector(".k2b-pdf-viewer")?.hasAttribute("aria-busy"));
      expect(await page.locator(".k2b-pdf-viewer__progress").count()).toBe(0);
      expect(await page.locator('[data-pdf-page="0"]').boundingBox()).toEqual(box);
      expect(await page.evaluate(() => (window as unknown as { pdfErrors: string[] }).pdfErrors)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a failed reload replaces the pages with its error, and a retry shows the new document", async () => {
    const page = await load("?request", undefined, false);
    try {
      const answer = (index: number, kind: string) =>
        page.evaluate(([i, k]) => (window as unknown as { pdfAnswer: (index: number, kind: string) => void }).pdfAnswer(i, k), [
          index,
          kind,
        ] as const);
      await answer(0, "long");
      await page.locator('[data-pdf-page="0"] img').waitFor();
      await page.evaluate(() => (window as unknown as { pdfNewRequest: () => void }).pdfNewRequest());
      await answer(1, "fail");
      const viewer = page.locator(".k2b-pdf-viewer");
      await page.waitForFunction(() => document.querySelector(".k2b-pdf-viewer")?.getAttribute("data-state") === "error");
      expect(await viewer.textContent()).toContain("The report could not be generated");
      expect(await page.locator(".k2b-pdf-viewer__document").evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");
      expect(await viewer.getAttribute("aria-busy")).toBeNull();
      await page.getByRole("button", { name: "Retry" }).click();
      await answer(2, "short");
      await page.waitForFunction(() => document.querySelectorAll("[data-pdf-page]").length === 3);
      await page.locator('[data-pdf-page="0"] img').waitFor();
      expect(await viewer.getAttribute("data-state")).toBe("shown");
      expect(await page.locator(".k2b-pdf-viewer__document").evaluate((element) => getComputedStyle(element).visibility)).toBe("visible");
    } finally {
      await page.close();
    }
  });

  // The end marker fills the layer while a drag selects; it must lie below the spans, or the drag selects nothing (#3302).
  test("dragging the mouse across several lines selects their text", async () => {
    const page = await load();
    try {
      const layer = '[data-pdf-page="0"] .k2b-pdf-viewer__text';
      await page.locator(`${layer} .k2b-pdf-viewer__text-end`).waitFor({ state: "attached" });
      const first = (await page.locator(`${layer} span`, { hasText: "Line 1 of page 1" }).boundingBox())!;
      const third = (await page.locator(`${layer} span`, { hasText: "Line 3 of page 1" }).boundingBox())!;
      await page.mouse.move(first.x + 2, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 4 });
      await page.mouse.move(third.x + third.width - 2, third.y + third.height / 2, { steps: 8 });
      await page.mouse.up();
      const selected = await page.evaluate(() => String(getSelection()));
      expect(selected).toContain("Line 2 of page 1");
      expect(selected).toContain("Line 3 of page");
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

  test("the bar is icons only: page number, zoom, and a pressed fit without a fill", async () => {
    const page = await load();
    try {
      await settled(page);
      const bar = page.locator(".k2b-pdf-viewer__bar");
      expect(await bar.locator(".k2b-pdf-viewer__page-number [aria-hidden]").textContent()).toBe("1 / 40");
      expect(await bar.locator("button").evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim()))).toEqual([
        "",
        "",
        "",
      ]);
      const fit = page.getByRole("button", { name: "Fit to width" });
      expect(await fit.getAttribute("aria-pressed")).toBe("true");
      const paint = await fit.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        text: getComputedStyle(document.body).color,
      }));
      expect(paint.background).toBe("rgba(0, 0, 0, 0)");
      expect(paint.color).not.toBe(paint.text);
    } finally {
      await page.close();
    }
  });

  // The bar has the size of every floating pill of small controls (`--k2b-pill-control`, `--k2b-pill-inset`), the
  // Notebooks editor pills too: the round background of each icon has the same space to the edge above, below, and at
  // the end, so the pill is never taller than its icons need.
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])
    test(`the pill keeps the same space around its icons on every side at ${viewport.width} px`, async () => {
      const page = await load("?open", viewport);
      try {
        await settled(page);
        const pill = await page.locator(".k2b-pdf-viewer__bar > .k2b-toolbar").evaluate((toolbar) => {
          const box = toolbar.getBoundingClientRect();
          const icons = Array.from(toolbar.querySelectorAll("button")).map((button) => button.getBoundingClientRect());
          return {
            height: box.height,
            radius: getComputedStyle(toolbar.querySelector("button")!).borderRadius,
            insets: icons.flatMap((icon) => [icon.top - box.top, box.bottom - icon.bottom]).concat(box.right - icons.at(-1)!.right),
          };
        });
        expect(pill.height).toBe(38);
        expect(pill.radius).toBe("9999px");
        for (const inset of pill.insets) expect(Math.abs(inset - pill.insets[0]!)).toBeLessThanOrEqual(0.5);
      } finally {
        await page.close();
      }
    });

  test("open adds one icon to the end of the pill, named for screen readers and the tooltip", async () => {
    const page = await load("?open");
    try {
      await settled(page);
      const buttons = page.locator(".k2b-pdf-viewer__bar button");
      expect(await buttons.count()).toBe(4);
      const open = buttons.last();
      expect(await open.getAttribute("aria-label")).toBe("Open in new tab");
      expect((await open.textContent())?.trim()).toBe("");
      // The ground is rounded and the pages sit in it without a second frame.
      const radius = await page.locator(".k2b-pdf-viewer").evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
      expect(radius).not.toBe("0px");
    } finally {
      await page.close();
    }
  });

  test("without zoom, the pill keeps only the host's open icon", async () => {
    const page = await load("?open&zoom=0");
    try {
      await settled(page);
      const labels = await page
        .locator(".k2b-pdf-viewer__bar button")
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
      expect(labels).toEqual(["Open in new tab"]);
      expect(await page.locator(".k2b-pdf-viewer__page-number").count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  test("fitted to the width, a page never grows past 100 % in a wide area", async () => {
    const page = await load("", { width: 2200, height: 900 });
    try {
      await settled(page);
      expect(await page.locator(".k2b-pdf-viewer__pages").getAttribute("data-zoom")).toBe("100");
      const width = (await page.locator('[data-pdf-page="0"]').boundingBox())!.width;
      expect(Math.round(width)).toBe(Math.floor((595 * 96) / 72));
    } finally {
      await page.close();
    }
  });

  for (const height of [416, 150])
    test(`fit="page" shows the whole first page above the bar, narrower than the area, at ${height} px`, async () => {
      const page = await load(`?fit=page&height=${height}`, { width: 420, height: 800 });
      try {
        await settled(page);
        const area = (await page.locator(".k2b-pdf-viewer__pages").boundingBox())!;
        const first = (await page.locator('[data-pdf-page="0"]').boundingBox())!;
        const bar = (await page.locator(".k2b-pdf-viewer__bar .k2b-toolbar").boundingBox())!;
        expect(first.y).toBeGreaterThanOrEqual(area.y);
        expect(first.y + first.height).toBeLessThanOrEqual(bar.y);
        expect(bar.y + bar.height).toBeLessThanOrEqual(area.y + area.height);
        expect(first.width).toBeLessThan(area.width - 24);
        expect(Math.abs(first.x + first.width / 2 - (area.x + area.width / 2))).toBeLessThan(8);
        const fit = page.getByRole("button", { name: "Show the whole page" });
        expect(await fit.getAttribute("aria-pressed")).toBe("true");
        await page.getByRole("button", { name: "Zoom in" }).click();
        await settled(page);
        expect(await fit.getAttribute("aria-pressed")).toBe("false");
        await fit.click();
        await settled(page);
        expect(Math.round((await page.locator('[data-pdf-page="0"]').boundingBox())!.width)).toBe(Math.round(first.width));
      } finally {
        await page.close();
      }
    });
});
