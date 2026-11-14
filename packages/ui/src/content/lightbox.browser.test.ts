import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, pageErrors, settled } from "../../test/browser";
import { pdfFixture } from "../../test/pdf-fixture";
import { expectCompactPills, measurePills, PILL_HEIGHT, PILL_SPACE } from "../../test/pill";

// The Lightbox shows each kind of file on one stage: pictures, PDFs drawn by pdf.js, Markdown through FileView, a
// document only as its preview PDF, and files without a preview. Layout, the top layer and pdf.js need a real engine,
// so the shipped browser build runs as an ES module with its chunks, as in an app.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const origin = "http://k2b-lightbox.test/";
// The icon font, served from the package, so the commands show their icons in screenshots.
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${origin}`);
const entry = resolve(import.meta.dir, "lightbox.fixture.ts");
const result = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
    import { createSignal, Show } from "solid-js";
    import { createComponent, render } from "solid-js/web";
    import { Button, Lightbox, dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
    const picture = (fill, width, height) => "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='" + width + "' height='" + height + "'><rect width='100%' height='100%' fill='" + fill + "'/><circle cx='50%' cy='50%' r='20%' fill='#fff7'/></svg>");
    const query = new URLSearchParams(location.search);
    const slow = query.has("slow");
    const later = (value, ms = slow ? 900 : 0) => new Promise((done) => setTimeout(() => done(value), ms));
    let failures = Number(query.get("fail") ?? 0);
    window.opened = [];
    window.lightboxClosed = 0;
    window.signed = 0;
    const items = [
      { name: "Kommode-vorher.jpg", meta: "JPG · 2.4 MB", src: picture("#a8a29e", 1200, 800), downloadUrl: "/kommode.jpg",
        actions: [{ label: "Rename", icon: "ti ti-pencil", onClick: () => void dialogCore.open((close) => {
          const body = document.createElement("div");
          body.innerHTML = "<h2>Rename</h2><input aria-label='Name' value='Kommode'><button type='button'>Done</button>";
          body.querySelector("button").onclick = () => close();
          return body;
        }) }] },
      { name: "Angebot-0412-Sekretär-Biedermeier-mit-Aufsatz-und-Schlüssel.pdf", meta: "PDF · 412 KB", src: "/doc.pdf", downloadUrl: "/doc.pdf",
        open: { onOpen: () => window.opened.push("pdf") } },
      { name: "Restaurierung.md", meta: "Markdown · 2 KB", file: { path: "Restaurierung.md", mediaType: "text/markdown" },
        load: () => later({ encoding: "utf8", mediaType: "text/markdown", content: "# Restaurierungsbericht\\n\\nDer Sekretär ist in **Kirschbaum** furniert.\\n\\n- Scharnier\\n- Intarsie\\n" }) },
      { name: "Bericht.docx", meta: "Word · 58 KB", file: { path: "Bericht.docx" }, downloadUrl: "/bericht.docx",
        open: { onOpen: () => window.opened.push("docx") },
        preview: () => failures-- > 0 ? later(Promise.reject(new Error("no libreoffice"))) : fetch("/doc.pdf").then((response) => response.blob()).then((blob) => later(blob)) },
      { name: "Archiv.zip", meta: "ZIP · 12 MB", downloadUrl: "/archiv.zip" },
      // A signed address resolved when shown: the first one has expired, "Try again" asks for a fresh one.
      { name: "Kaputt.png", meta: "PNG · 1 KB", downloadUrl: "/missing.png",
        src: () => later(window.signed++ === 0 ? "/missing.png" : picture("#93c5fd", 800, 600)) },
      // An address the server refuses: the Lightbox shows its own failure, not an endless placeholder.
      { name: "Gesperrt.pdf", meta: "PDF · 20 KB", src: "/forbidden.pdf" },
    ];
    const [index, setIndex] = createSignal(Number(query.get("index") ?? 0));
    const [open, setOpen] = createSignal(false);
    render(() => [
      createComponent(Button, { size: "sm", variant: "secondary", onClick: () => setOpen(true), children: "View files" }),
      createComponent(Show, { get when() { return open(); }, get children() {
        return createComponent(Lightbox, { items, get index() { return index(); }, onIndexChange: setIndex,
          onClose: () => { window.lightboxClosed++; setOpen(false); } });
      } }),
    ], document.getElementById("app"));
  `,
  },
  target: "browser",
  format: "esm",
  splitting: true,
  naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
});
if (!result.success) throw new AggregateError(result.logs, "Could not build the Lightbox fixture");
const assets = new Map(
  await Promise.all(result.outputs.map(async (output) => [basename(output.path), await output.arrayBuffer()] as const)),
);
const pdf = pdfFixture(4, 3);
/** Set FILES_SHOTS to a folder to keep screenshots of the states the tests reach. */
const shots = process.env.FILES_SHOTS;

// pdf.js and the dialogs take a moment; a flow takes a few seconds.
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Options = { search?: string; width?: number; height?: number; dark?: boolean; phone?: boolean };
const load = async ({ search = "", width = 1440, height = 900, dark = false, phone = false }: Options = {}): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : shots ? { deviceScaleFactor: 2 } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  await page.route(`${origin}**`, (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "doc.pdf") return route.fulfill({ body: Buffer.from(pdf), contentType: "application/pdf" });
    if (path === "missing.png") return route.fulfill({ status: 404, body: "" });
    if (path === "forbidden.pdf") return route.fulfill({ status: 403, json: { message: "You may not read this file." } });
    const asset = assets.get(path);
    if (asset) return route.fulfill({ body: Buffer.from(asset), contentType: path.endsWith(".js") ? "text/javascript" : undefined });
    if (path.endsWith(".woff2") || path.endsWith(".woff")) return route.fulfill({ path: resolve(ui, "dist", path) });
    return route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${icons}</style><style>body{margin:0;padding:2rem}</style></head>` +
        `<body class="k2b-ui${dark ? " k2b-dark" : ""}" data-theme="${dark ? "dark" : "light"}"><main id="app"></main>` +
        `<p style="max-width:40rem">Behind the veil: a list of files, an offer and its pictures.</p><script type="module" src="/entry.js"></script></body></html>`,
    });
  });
  const errors = pageErrors(page);
  await page.goto(`${origin}${search}`);
  await page
    .getByRole("button", { name: "View files" })
    .click()
    .catch((error: unknown) => {
      throw new AggregateError([error, ...errors], "The fixture did not start");
    });
  await page.locator("dialog.k2b-lightbox[open]").waitFor();
  return page;
};
const name = (page: Page) => page.locator(".k2b-lightbox__name b").textContent();
const edge = (page: Page, direction: "previous" | "next") =>
  page.locator(`.k2b-lightbox__edge[data-direction="${direction}"]`).evaluate((button) => getComputedStyle(button).visibility);
const shot = async (page: Page, file: string) => {
  if (!shots) return;
  await settled(page);
  await page.screenshot({ path: `${shots}/${file}` });
};

/** A close-up of one control or pill with some room around it, for before and after comparisons. */
const closeUp = async (page: Page, selector: string, file: string) => {
  if (!shots) return;
  await settled(page);
  const box = (await page.locator(selector).boundingBox())!;
  await page.screenshot({
    path: `${shots}/${file}`,
    clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 },
  });
};

describe("@k2b/ui Lightbox", () => {
  test("a picture: name in one line, Download and Close at the top, zoom at the bottom, no counter, edge buttons", async () => {
    const page = await load();
    try {
      await page.locator(".k2b-lightbox__image").waitFor();
      expect(await name(page)).toBe("Kommode-vorher.jpg");
      expect(await page.locator(".k2b-lightbox").textContent()).not.toMatch(/\d+ \/ 7/);
      expect(await edge(page, "previous")).toBe("hidden");
      expect(await edge(page, "next")).toBe("visible");
      expect(await page.locator(".k2b-lightbox__percent").textContent()).toBe("100 %");
      await page.getByRole("button", { name: "Zoom in" }).click();
      expect(await page.locator(".k2b-lightbox__percent").textContent()).toBe("125 %");
      expect(await page.locator(".k2b-lightbox .k2b-thumbnail-strip").count()).toBe(1);
      // The light veil leaves the page behind it readable.
      await settled(page);
      const veil = await page.locator("dialog.k2b-lightbox").evaluate((dialog) => getComputedStyle(dialog, "::backdrop").backgroundColor);
      expect(veil).toMatch(/^(rgba?|color)\(/);
      expect(veil).not.toMatch(/\b0, 0, 0\b/);
      await shot(page, "lightbox-bild-light-1440.png");
    } finally {
      await page.context().close();
    }
  });

  test("a PDF: the blue Open leads the actions, the page shows at the bottom; ← and → step and the ends hide their button", async () => {
    const page = await load({ search: "?index=1" });
    try {
      await page.locator('.k2b-lightbox [data-pdf-page="0"] img').waitFor();
      const labels = await page
        .locator(".k2b-lightbox__actions")
        .locator("button, a")
        .evaluateAll((controls) => controls.map((control) => control.getAttribute("aria-label") ?? control.textContent?.trim()));
      expect(labels).toEqual(["Open", "Download", "Close"]);
      await page.waitForFunction(() => document.querySelector(".k2b-lightbox__page")?.textContent === "Page 1 / 4");
      // The long name keeps one line and gives way with an ellipsis.
      const head = await page.locator(".k2b-lightbox__name b").evaluate((element) => ({
        lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight || "20")),
        clipped: element.scrollWidth > element.clientWidth || getComputedStyle(element).textOverflow === "ellipsis",
      }));
      expect(head.lines).toBeLessThanOrEqual(1);
      expect(head.clipped).toBe(true);
      await page.getByRole("button", { name: "Open", exact: true }).click();
      expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["pdf"]);
      await shot(page, "lightbox-pdf-light-1440.png");
      await page.locator(".k2b-lightbox__stage").focus();
      await page.keyboard.press("ArrowLeft");
      expect(await name(page)).toBe("Kommode-vorher.jpg");
      await page.keyboard.press("ArrowLeft");
      expect(await name(page)).toBe("Kommode-vorher.jpg");
    } finally {
      await page.context().close();
    }
  });

  // The head's pills and the zoom pill are pills of small controls like the Notebooks editor pills (`k2b-pill`): 38 px
  // high, the same space between the edge and each round control on every side, also beside the blue Open.
  for (const [width, phone] of [
    [1440, false],
    [390, true],
  ] as const)
    test(`every pill is 38 px with the same space around its controls (${width} px)`, async () => {
      const page = await load({ search: "?index=1", width, phone });
      try {
        await page.waitForFunction(() => document.querySelector(".k2b-lightbox__page")?.textContent === "Page 1 / 4");
        if (!phone) {
          await closeUp(page, ".k2b-lightbox__actions", "lightbox-actions-light-1440.png");
          await closeUp(page, '.k2b-lightbox__edge[data-direction="previous"]', "lightbox-previous-light-1440.png");
          await page.getByRole("button", { name: "Zoom out" }).hover();
          await closeUp(page, ".k2b-lightbox__tools", "lightbox-zoom-hover-light-1440.png");
          await page.mouse.move(0, 0);
        }
        expectCompactPills(await measurePills(page, ".k2b-lightbox__actions, .k2b-lightbox__tools"));
        expect(await page.locator(".k2b-lightbox__name").evaluate((pill) => pill.getBoundingClientRect().height)).toBe(PILL_HEIGHT);
        // The focus ring of a control stays inside the pill's space.
        await page.getByRole("button", { name: "Close" }).focus();
        const ring = await page.getByRole("button", { name: "Close" }).evaluate((control) => {
          const style = getComputedStyle(control);
          return Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
        });
        expect(ring).toBeLessThan(PILL_SPACE);
        if (!phone) await shot(page, "lightbox-pills-light-1440.png");
      } finally {
        await page.context().close();
      }
    });

  test("Markdown lifts its first heading into the head; a document shows its preview PDF read-only", async () => {
    const page = await load({ search: "?index=2" });
    try {
      await page.waitForFunction(() => document.querySelector(".k2b-lightbox__name b")?.textContent === "Restaurierungsbericht");
      expect(await page.locator(".k2b-lightbox__name span").textContent()).toContain("Restaurierung.md");
      await shot(page, "lightbox-markdown-light-1440.png");
      await page.keyboard.press("ArrowRight");
      await page.locator('.k2b-lightbox [data-pdf-page="0"] img').waitFor();
      expect(await page.locator(".k2b-lightbox__name span").textContent()).toContain("view only");
      await shot(page, "lightbox-office-light-1440.png");
    } finally {
      await page.context().close();
    }
  });

  test("a document that cannot be converted says so with Open and Download; a picture that fails offers Try again", async () => {
    const page = await load({ search: "?index=3&fail=1&slow" });
    try {
      // The wait shows "Converting for the preview …" after a short delay.
      await page.getByText("Converting for the preview …").waitFor();
      await shot(page, "lightbox-office-umwandeln-light-1440.png");
      await page.getByText("Preview not possible").waitFor();
      expect(await page.locator(".k2b-lightbox__notice").getByRole("button", { name: "Open" }).count()).toBe(1);
      expect(await page.locator(".k2b-lightbox__notice").getByRole("link", { name: "Download" }).count()).toBe(1);
      await shot(page, "lightbox-office-nicht-moeglich-light-1440.png");
      await page.keyboard.press("ArrowRight");
      await page.getByText("There is no preview for this file").waitFor();
      await page.keyboard.press("ArrowRight");
      await page.getByText("The preview could not be loaded").waitFor();
      expect(await page.getByRole("button", { name: "Try again" }).count()).toBe(1);
      await shot(page, "lightbox-fehler-light-1440.png");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.locator(".k2b-lightbox__image").waitFor();
      expect(await page.locator(".k2b-lightbox__content").getAttribute("data-state")).toBe("ready");
      // A PDF the server refuses fails the same way; the last file hides the next button.
      await page.keyboard.press("ArrowRight");
      await page.getByText("The preview could not be loaded").waitFor();
      expect(await edge(page, "next")).toBe("hidden");
    } finally {
      await page.context().close();
    }
  });

  test("Escape closes a dialog an action opened first, then the Lightbox, and focus returns to the opener", async () => {
    const page = await load();
    try {
      await page.getByRole("button", { name: "Rename" }).click();
      await page.waitForFunction(() => document.activeElement?.matches("input[aria-label='Name']"));
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await name(page)).toBe("Kommode-vorher.jpg");
      expect(await page.locator("dialog.k2b-lightbox[open]").count()).toBe(1);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.locator("dialog.k2b-lightbox").count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("View files");
      expect(await page.evaluate(() => (window as unknown as { lightboxClosed: number }).lightboxClosed)).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  test("dark theme: a dark veil", async () => {
    const page = await load({ dark: true });
    try {
      await page.locator(".k2b-lightbox__image").waitFor();
      const veil = await page.locator("dialog.k2b-lightbox").evaluate((dialog) => {
        const probe = document.createElement("div");
        probe.style.color = getComputedStyle(dialog, "::backdrop").backgroundColor;
        document.body.append(probe);
        const [r = 255, g = 255, b = 255] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(Number);
        probe.remove();
        return (r + g + b) / 3;
      });
      expect(veil).toBeLessThan(80);
      await shot(page, "lightbox-bild-dark-1440.png");
    } finally {
      await page.context().close();
    }
  });

  test("a phone: full screen, no edge buttons, a swipe steps and a pull down closes", async () => {
    const page = await load({ width: 390, height: 844, phone: true });
    try {
      await page.locator(".k2b-lightbox__image").waitFor();
      expect(
        await page
          .locator(".k2b-lightbox__edge")
          .first()
          .evaluate((button) => getComputedStyle(button).display),
      ).toBe("none");
      const box = (await page.locator("dialog.k2b-lightbox").boundingBox())!;
      expect([box.width, box.height]).toEqual([390, 844]);
      await shot(page, "lightbox-bild-light-390.png");
      // Chromium takes a real touch through the driver. WebKit on Linux has no touch input and no Touch constructor,
      // so there the same sequence arrives as touch events carrying their points, which is all the Lightbox reads.
      const swipe = async (from: [number, number], to: [number, number]) => {
        if (browserName === "chromium") {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
          for (let step = 1; step <= 5; step++)
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: from[0] + ((to[0] - from[0]) * step) / 5, y: from[1] + ((to[1] - from[1]) * step) / 5 }],
            });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          return;
        }
        await page.evaluate(
          ([from, to]) => {
            const stage = document.querySelector(".k2b-lightbox__stage")!;
            const send = (type: string, touches: [number, number][], changed: [number, number]) => {
              const event = new Event(type, { bubbles: true });
              const point = ([clientX, clientY]: [number, number]) => ({ identifier: 1, target: stage, clientX, clientY });
              Object.defineProperties(event, {
                touches: { value: touches.map(point) },
                changedTouches: { value: [point(changed)] },
              });
              stage.dispatchEvent(event);
            };
            send("touchstart", [from], from);
            send("touchmove", [to], to);
            send("touchend", [], to);
          },
          [from, to] as const,
        );
      };
      await swipe([320, 400], [80, 410]);
      expect(await name(page)).toContain("Angebot-0412");
      await swipe([200, 200], [205, 500]);
      await settled(page);
      expect(await page.locator("dialog.k2b-lightbox").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });
});
