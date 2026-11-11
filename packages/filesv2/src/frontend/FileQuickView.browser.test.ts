import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// Frames that keep their size, the stage, zoom, the phone layout and the PDF viewer need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the quick view uses only its own classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./FileQuickView.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-file-quick-view-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Quick view harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Invented demo files: a picture as the service's previews draw it, in two sizes of the same 16:10 frame. */
const picture = (width: number, fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width * 0.625}"><rect width="100%" height="100%" fill="${fill}"/></svg>`;
const firstPage = `<svg xmlns="http://www.w3.org/2000/svg" width="905" height="1280"><rect width="100%" height="100%" fill="#fff"/><rect x="80" y="120" width="600" height="40" fill="#1e3a8a"/></svg>`;
const readme = [
  "# Summer party 2026",
  "",
  "Everything the organising team needs: the schedule, the posters and the shopping list.",
  "",
  "## Schedule",
  "",
  "| Stand | Team | Starts |",
  "| --- | --- | ---: |",
  "| Grill | Team A | 14:00 |",
  "| Drinks | Team B | 13:30 |",
  "",
  ...Array.from({ length: 40 }, (_, index) => `- Item ${index + 1} for the shopping list`),
].join("\n");
const pdf = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
const files: Record<string, [string, string | Buffer]> = {
  "Workshop.jpg": ["image/jpeg", "jpeg bytes"],
  "README.md": ["text/markdown", readme],
  "Broken.jpg": ["image/jpeg", "jpeg bytes"],
  "Report.pdf": ["application/pdf", pdf],
  "Offer.docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx bytes"],
  "Archive.zip": ["application/zip", "PK"],
  "Clip.webm": ["video/webm", readFileSync(`${ui}test/media/landscape-320x180.webm`)],
  "The quarterly planning notes of the summer party organising committee, final version for the board.jpg": ["image/jpeg", "jpeg bytes"],
};
const folder = Object.entries(files).map(([name, [, body]]) => ({ name, size: Buffer.byteLength(body) }));

/** Every preview request: file name, size and whether it was answered from a finished preview. */
const previewRequests: { name: string; size: string; status: number }[] = [];
const retried: string[] = [];

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** `holdSharp` keeps back the large preview of Workshop.jpg, `holdSmall` its small one, as a slow first view would. */
const open = async (options: BrowserContextOptions, holdSharp?: Promise<void>, holdSmall?: Promise<void>) => {
  previewRequests.length = 0;
  retried.length = 0;
  let officePolls = 0;
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  await context.addInitScript((list) => {
    (window as unknown as { folder: unknown }).folder = list;
  }, folder);
  const tab = await context.newPage();
  await tab.route("http://quick.test/**", async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page("light", "en") });
    if (path === "/api/filesv2/bases/personal/preview/retry") {
      retried.push((route.request().postDataJSON() as { path: string }).path.split("/").at(-1)!);
      return route.fulfill({ json: { state: "pending" } });
    }
    if (path === "/api/filesv2/bases/personal/preview") {
      const name = url.searchParams.get("path")!.split("/").at(-1)!;
      const size = url.searchParams.get("size")!;
      // Every address carries the file's version, so the browser may keep the answer.
      if (url.searchParams.get("rev") !== `r-${name}`) return route.fulfill({ status: 400 });
      const answer = async (): Promise<[number, string, string | Buffer, Record<string, string>?]> => {
        if (name === "Broken.jpg" && !retried.includes(name)) return [404, "application/json", JSON.stringify({ code: "preview_failed" })];
        if (name.endsWith(".jpg") && (size === "small" || size === "large")) {
          if (name === "Workshop.jpg" && size === "large" && holdSharp) await holdSharp;
          if (name === "Workshop.jpg" && size === "small" && holdSmall) await holdSmall;
          return [200, "image/svg+xml", picture(size === "small" ? 320 : 1280, size === "small" ? "#94a3b8" : "#0e7490")];
        }
        if ((name === "Report.pdf" || name === "Offer.docx") && size === "large") return [200, "image/svg+xml", firstPage];
        if (name === "Offer.docx" && size === "pdf")
          return officePolls++ === 0
            ? [202, "application/json", JSON.stringify({ state: "pending" }), { "retry-after": "1" }]
            : [200, "application/pdf", pdf];
        if (name === "README.md" && size === "text") return [200, "text/plain; charset=utf-8", readme.slice(0, 400)];
        return [404, "application/json", JSON.stringify({ code: "preview_unsupported" })];
      };
      const [status, contentType, body, headers] = await answer();
      previewRequests.push({ name, size, status });
      return route.fulfill({ status, contentType, body, headers });
    }
    if (path === "/api/filesv2/bases/personal/download") {
      const name = (route.request().postDataJSON() as { path: string }).path.split("/").at(-1)!;
      return route.fulfill({
        json: {
          url: `http://quick.test/v1/direct/${Buffer.from(name).toString("hex")}`,
          method: "GET",
          expires: "2026-09-28T11:00:00.000Z",
        },
      });
    }
    if (path.startsWith("/v1/direct/")) {
      const name = Buffer.from(path.slice("/v1/direct/".length), "hex").toString();
      const file = files[name];
      if (!file) return route.fulfill({ status: 404 });
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
      const body = Buffer.from(file[1]);
      const headers = { "access-control-allow-origin": "*", "accept-ranges": "bytes" };
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
        return route.fulfill({
          status: 206,
          contentType: file[0],
          body: body.subarray(start, end + 1),
          headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` },
        });
      }
      return route.fulfill({ contentType: file[0], body, headers });
    }
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://quick.test/");
  await tab.waitForFunction(() => !!window.preview);
  await tab.evaluate(async () => {
    await document.fonts.load("1em tabler-icons");
  });
  return tab;
};
const show = async (tab: Page, name: string, options: { editable?: string[] } = {}) => {
  await tab.evaluate(([name, options]) => window.preview.open(name, options), [name, options] as const);
  await tab.waitForSelector(".k2b-quick-view[open]");
  await settled(tab);
};
type Box = { left: number; top: number; width: number; height: number };
const box = (tab: Page, selector: string): Promise<Box> =>
  tab.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
const actionNames = (tab: Page) =>
  tab.$$eval(".k2b-quick-view__actions button", (buttons) => buttons.map((button) => button.getAttribute("aria-label")));
const chip = (tab: Page) => tab.$eval(".k2b-quick-view__name", (name) => (name as HTMLElement).innerText.replace(/\s+/g, " ").trim());

describe("file previews in the list", () => {
  for (const [label, options] of [
    ["1440", desktop],
    ["390", phone],
  ] as const)
    test(`each file shows its content in a fixed place; a late preview shows a placeholder and moves nothing (${label})`, async () => {
      let release = () => {};
      const tab = await open(
        options,
        undefined,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      try {
        await tab.evaluate(() => window.preview.list());
        await tab.waitForSelector(".filesv2-list__row");
        const workshop = '.filesv2-list__row:has-text("Workshop.jpg") .filesv2-thumbnail';
        const rows = () => tab.$$eval(".filesv2-list__row", (all) => all.map((row) => Math.round(row.getBoundingClientRect().top)));
        const before = { rows: await rows(), tile: await box(tab, workshop) };
        // No placeholder for a quick answer: it appears only after 200 ms.
        expect(await tab.$eval(workshop, (tile) => tile.classList.contains("k2b-skeleton"))).toBe(false);
        await tab.waitForSelector(`${workshop}.k2b-skeleton`, { timeout: 2_000 });
        release();
        await tab.waitForSelector(`${workshop} img[data-ready]`);
        await tab.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains("k2b-skeleton"), workshop);
        expect(await rows()).toEqual(before.rows);
        expect(await box(tab, workshop)).toEqual(before.tile);
        // A text shows its first lines; a file without a preview, or whose preview failed, keeps its type icon quietly.
        await tab.waitForFunction(() =>
          document
            .querySelector('.filesv2-list__row:has-text("README.md") .filesv2-thumbnail__text')
            ?.textContent?.includes("Summer party"),
        );
        await tab.waitForSelector(
          '.filesv2-list__row:has-text("Broken.jpg") .k2b-file-type-icon, .filesv2-list__row:has-text("Broken.jpg") i',
        );
        expect(await tab.$('.filesv2-list__row:has-text("Archive.zip") img')).toBeNull();
        expect(previewRequests.some((request) => request.name === "Archive.zip")).toBe(false);
        await settled(tab);
        await tab.screenshot({ path: `/tmp/files11-shots/list-light-${label}.png` });
      } finally {
        await tab.context().close();
      }
    });
});

describe("file quick view in a browser", () => {
  test("shows the name, the commands and the position; the arrows step, Space and Escape close", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Workshop.jpg");
      expect(await chip(tab)).toMatch(/^Workshop\.jpg 10\sB$/);
      expect(await actionNames(tab)).toEqual(["Download", "Share publicly", "Close"]);
      expect(await tab.$eval(".k2b-quick-view__count", (count) => (count as HTMLElement).innerText.replace(/\s+/g, " ").trim())).toBe(
        `1 / ${folder.length}`,
      );
      // The film strip shows every file of the folder, the current one marked.
      expect(await tab.$$eval(".k2b-quick-view__strip button", (tiles) => tiles.length)).toBe(folder.length);
      await tab.keyboard.press("ArrowRight");
      await settled(tab);
      expect(await chip(tab)).toContain("README.md");
      await tab.keyboard.press("ArrowLeft");
      await tab.keyboard.press("ArrowLeft");
      await settled(tab);
      expect(await chip(tab)).toContain("The quarterly planning notes");
      expect(await tab.evaluate(() => window.preview.steps)).toEqual(["README.md", "Workshop.jpg", folder.at(-1)!.name]);
      await tab.keyboard.press(" ");
      await settled(tab);
      expect(await tab.$(".k2b-quick-view")).toBeNull();
      await show(tab, "Archive.zip");
      await tab.keyboard.press("Escape");
      await settled(tab);
      expect(await tab.$(".k2b-quick-view")).toBeNull();
      expect(await tab.evaluate(() => window.preview.closed)).toBe(2);
    } finally {
      await tab.context().close();
    }
  });

  test("a photo stands at once from its small preview, and the sharp one fades in on the same frame", async () => {
    let release = () => {};
    const tab = await open(
      desktop,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    try {
      await show(tab, "Workshop.jpg");
      await tab.waitForSelector(".filesv2-quick-image[data-sized]");
      const frame = await box(tab, ".filesv2-quick-image");
      expect(Math.abs(frame.width / frame.height - 1.6)).toBeLessThan(0.02);
      expect(await tab.$eval(".filesv2-quick-image__sharp", (image) => image.hasAttribute("data-ready"))).toBe(false);
      release();
      await tab.waitForSelector(".filesv2-quick-image__sharp[data-ready]");
      await settled(tab);
      expect(await box(tab, ".filesv2-quick-image")).toEqual(frame);
      // The frame fills the stage's height or width.
      const stage = await box(tab, ".k2b-quick-view__stage");
      expect(frame.width >= stage.width - 1 || frame.height >= stage.height - 1).toBe(true);
      await tab.screenshot({ path: "/tmp/files11-shots/quick-view-light-1440.png" });
    } finally {
      await tab.context().close();
    }
  });

  test("+ zooms a photo and the stage scrolls; the pill keeps its place on every file", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Workshop.jpg");
      await tab.waitForSelector(".filesv2-quick-image__sharp[data-ready]");
      const pill = await box(tab, ".k2b-quick-view__bar .k2b-toolbar");
      const frame = await box(tab, ".filesv2-quick-image");
      await tab.keyboard.press("+");
      await settled(tab);
      expect(await tab.$eval(".k2b-quick-view__percent", (label) => (label as HTMLElement).innerText.trim())).toBe("125 %");
      expect((await box(tab, ".filesv2-quick-image")).width).toBe(Math.round(frame.width * 1.25));
      expect(await tab.$eval(".k2b-quick-view__stage", (stage) => stage.scrollWidth > stage.clientWidth)).toBe(true);
      expect(await box(tab, ".k2b-quick-view__bar .k2b-toolbar")).toEqual(pill);
      // A text cannot zoom: its controls stay in place, disabled, and the zoom starts again at 100 % on every file.
      await tab.keyboard.press("ArrowRight");
      await settled(tab);
      expect(await tab.$eval(".k2b-quick-view__percent", (label) => (label as HTMLElement).innerText.trim())).toBe("100 %");
      expect(await tab.$eval('[aria-label="Zoom in"]', (button) => (button as HTMLButtonElement).disabled)).toBe(true);
      expect(await box(tab, ".k2b-quick-view__bar .k2b-toolbar")).toEqual(pill);
    } finally {
      await tab.context().close();
    }
  });

  test("a preview that failed says so calmly, and Try again draws it", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Broken.jpg");
      await tab.waitForSelector(".filesv2-quick-state");
      const text = await tab.$eval(".filesv2-quick-state", (state) => (state as HTMLElement).innerText);
      await tab.screenshot({ path: "/tmp/files11-shots/quick-view-failed-light-1440.png" });
      expect(text).toContain("The preview could not be created");
      expect(text).toContain("The file itself is fine.");
      await tab.click(".filesv2-quick-state button:has-text('Download')");
      expect(await tab.evaluate(() => window.preview.downloads)).toEqual(["Broken.jpg"]);
      await tab.click(".filesv2-quick-state button:has-text('Try again')");
      await tab.waitForSelector(".filesv2-quick-image__sharp[data-ready]");
      expect(retried).toEqual(["Broken.jpg"]);
    } finally {
      await tab.context().close();
    }
  });

  test("a PDF reads in the PDF viewer and opens in a new tab", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Report.pdf");
      expect(await actionNames(tab)).toEqual(["Open in new tab", "Download", "Share publicly", "Close"]);
      await tab.waitForSelector('.k2b-pdf-viewer:is([data-state="shown"], [data-state="undrawable"])');
      // The viewer's own zoom stays off: the quick view's pill zooms the pages.
      expect(await tab.$(".k2b-pdf-viewer__bar")).toBeNull();
      const popup = tab.waitForEvent("popup");
      await tab.click('[aria-label="Open in new tab"]');
      expect(new URL((await popup).url()).pathname).toBe("/app/filesv2/pdf/personal/Summer%20party/Report.pdf");
    } finally {
      await tab.context().close();
    }
  });

  test("an Office document waits for its PDF and says it is shown as one", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Offer.docx");
      expect(await chip(tab)).toMatch(/^Offer\.docx 10\sB · shown as PDF$/);
      await tab.waitForSelector('.k2b-pdf-viewer:is([data-state="shown"], [data-state="undrawable"])', { timeout: 10_000 });
      const polls = previewRequests.filter((request) => request.name === "Offer.docx" && request.size === "pdf");
      expect(polls.map((request) => request.status)).toEqual([202, 200]);
    } finally {
      await tab.context().close();
    }
  });

  test("Markdown reads in a column and offers its editor", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "README.md", { editable: ["README.md"] });
      await tab.waitForSelector(".filesv2-quick-reading .k2b-content-markdown");
      expect(await actionNames(tab)).toEqual(["Edit", "Download", "Share publicly", "Close"]);
      const column = await box(tab, ".filesv2-quick-reading");
      expect(column.width).toBeLessThanOrEqual(768);
      await tab.click('[aria-label="Edit"]');
      expect(await tab.evaluate(() => window.preview.edits)).toEqual(["README.md"]);
      expect(await tab.$(".k2b-quick-view")).toBeNull();
    } finally {
      await tab.context().close();
    }
  });

  test("a file without a preview offers its download", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Archive.zip");
      await tab.click(".filesv2-quick-state button");
      expect(await tab.evaluate(() => window.preview.downloads)).toEqual(["Archive.zip"]);
    } finally {
      await tab.context().close();
    }
  });

  test("a long name stays on one line and shows all of it on pointing", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, folder.at(-1)!.name);
      const name = await tab.$eval(".k2b-quick-view__name > b", (element) => ({
        cut: element.scrollWidth > element.clientWidth,
        lines: Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight)),
      }));
      expect(name).toEqual({ cut: true, lines: 1 });
      await tab.hover(".k2b-quick-view__name > b");
      expect(await tab.getAttribute(".k2b-quick-view__name > b", "title")).toBe(folder.at(-1)!.name);
    } finally {
      await tab.context().close();
    }
  });

  test("on a phone the stage keeps the screen: no film strip, the pill steps", async () => {
    const tab = await open(phone);
    try {
      await show(tab, "Workshop.jpg");
      await tab.waitForSelector(".filesv2-quick-image__sharp[data-ready]");
      expect(await tab.$eval(".k2b-quick-view__strip", (strip) => getComputedStyle(strip).display)).toBe("none");
      const pill = await box(tab, ".k2b-quick-view__bar .k2b-toolbar");
      expect(pill.top + pill.height).toBeLessThanOrEqual(844);
      expect(pill.width).toBeLessThanOrEqual(390);
      await tab.click('[aria-label="Next file"]');
      await settled(tab);
      expect(await chip(tab)).toContain("README.md");
      await tab.screenshot({ path: "/tmp/files11-shots/quick-view-light-390.png" });
    } finally {
      await tab.context().close();
    }
  });

  // A Markdown table's lines reach 0.5rem past the text; the boxes that clip or scroll around a README leave that room.
  for (const [label, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`a README's table keeps its line ends in the quick view and in the folder, and nothing scrolls sideways (${label})`, async () => {
      const tab = await open(options);
      try {
        const fit = (selector: string) =>
          tab.$eval(selector, (root) => {
            const table = root.querySelector(".k2b-content-markdown__table")!;
            const wrap = table.getBoundingClientRect();
            const boxes = [];
            for (let element = table.parentElement; element && element !== root.parentElement; element = element.parentElement) {
              if (getComputedStyle(element).overflowX === "visible") continue;
              const left = element.getBoundingClientRect().left + element.clientLeft;
              boxes.push({
                sideways: element.scrollWidth - element.clientWidth,
                inside: wrap.left >= left - 0.5 && wrap.right <= left + element.clientWidth + 0.5,
              });
            }
            return boxes;
          });
        await show(tab, "README.md");
        await tab.waitForSelector(".filesv2-quick-reading .k2b-content-markdown__table");
        const reading = await fit(".filesv2-quick-reading");
        expect(reading.length).toBeGreaterThan(0);
        expect(reading).toEqual(reading.map(() => ({ sideways: 0, inside: true })));
        await tab.keyboard.press("Escape");
        await tab.evaluate(() => window.preview.readme("README.md"));
        await tab.waitForSelector(".filesv2-folder-readme .k2b-content-markdown__table");
        const inFolder = await fit(".filesv2-folder-readme");
        expect(inFolder.length).toBeGreaterThan(0);
        expect(inFolder).toEqual(inFolder.map(() => ({ sideways: 0, inside: true })));
      } finally {
        await tab.context().close();
      }
    });
  }

  test("a video plays in the quick view", async () => {
    const tab = await open(desktop);
    try {
      await show(tab, "Clip.webm");
      await tab.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement | null)?.readyState! >= 1);
      expect(await tab.$eval(".k2b-video-player__video", (video) => video.hasAttribute("playsinline"))).toBe(true);
    } finally {
      await tab.context().close();
    }
  });
});
