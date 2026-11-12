import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { pdfFixture } from "../../../ui/test/pdf-fixture";

// Files shows a file large in the Lightbox of @k2b/ui: pictures and videos from a short-lived lease, PDFs from Files'
// own inline address, text read within its bound, and the commands the preview dialog had. pdf.js, the top layer and
// range requests need a real engine, so the harness is an ES module with its chunks, as in the app.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8").replace(
  /^@(import|source|custom-variant)[^\n]*\n/gm,
  "",
);

const buildHarness = async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./FileLightbox.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    splitting: true,
    naming: { entry: "harness.js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "solid-file-lightbox-test",
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
  if (!build.success) throw new AggregateError(build.logs, "File Lightbox harness build failed");
  return new Map(
    await Promise.all(
      build.outputs.map(
        async (output): Promise<[string, [string, Buffer]]> => [
          `/${basename(output.path)}`,
          [output.path.endsWith(".js") ? "text/javascript; charset=utf-8" : output.type, Buffer.from(await output.arrayBuffer())],
        ],
      ),
    ),
  );
};

const assets = await buildHarness();
const sheets: Record<string, [string, string]> = {
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const html = (lang: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="light"><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`;

/** Invented demo files. */
const files: Record<string, [string, string | Buffer]> = {
  "README.md": ["text/markdown", "# Summer party 2026\n\nEverything the organising team needs.\n\n- Grill\n- Drinks\n"],
  "Packing_list.txt": ["text/plain", "Packing list\n\n- Pavilion 6 x 3 m\n- Stage platforms (4)\n"],
  "Poster.svg": [
    "image/svg+xml",
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#0e7490"/></svg>`,
  ],
  "Report.pdf": ["application/pdf", Buffer.from(pdfFixture(3, 2))],
  "Clip.webm": ["video/webm", readFileSync(`${ui}test/media/landscape-320x180.webm`)],
  "Archive.zip": ["application/zip", "PK"],
};
const all = Object.entries(files).map(([name, [, body]]) => ({ name, size: Buffer.byteLength(body) }));

setDefaultTimeout(30_000);
const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
/** Set FILES_SHOTS to a folder to keep screenshots of the states the tests reach. */
const shots = process.env.FILES_SHOTS;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Session = { tab: Page; errors: string[]; leases: string[]; media: { range: string | null }[]; failing: Set<string> };
const start = async (options: BrowserContextOptions): Promise<Session> => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  tab.setDefaultTimeout(12_000);
  const session: Session = { tab, errors: pageErrors(tab), leases: [], media: [], failing: new Set() };
  await tab.route("http://lightbox.test/**", async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html("en") });
    if (path === "/api/filesv2/bases/personal/download") {
      const name = (route.request().postDataJSON() as { path: string }).path.split("/").at(-1)!;
      session.leases.push(name);
      if (session.failing.delete(name))
        return route.fulfill({ status: 503, json: { error: "unavailable", message: "Storage is unavailable" } });
      return route.fulfill({
        json: {
          url: `http://lightbox.test/v1/direct/${Buffer.from(name).toString("hex")}`,
          method: "GET",
          expires: "2026-09-28T11:00:00.000Z",
        },
      });
    }
    if (path.startsWith("/app/filesv2/pdf/personal/")) {
      const name = path.split("/").at(-1)!;
      return route.fulfill({ contentType: "application/pdf", body: Buffer.from(files[name]![1]) });
    }
    if (path.startsWith("/v1/direct/")) {
      const name = Buffer.from(path.slice("/v1/direct/".length), "hex").toString();
      const file = files[name];
      if (!file) return route.fulfill({ status: 404 });
      const body = Buffer.from(file[1]);
      const video = file[0].startsWith("video/");
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
      const headers = { "access-control-allow-origin": "*", "accept-ranges": "bytes" };
      if (video) session.media.push({ range: range?.[0] ?? null });
      if (range) {
        const first = Number(range[1]);
        const last = Math.min(range[2] ? Number(range[2]) : body.length - 1, body.length - 1);
        return route.fulfill({
          status: 206,
          contentType: video ? "application/octet-stream" : file[0],
          body: body.subarray(first, last + 1),
          headers: { ...headers, "content-range": `bytes ${first}-${last}/${body.length}` },
        });
      }
      return route.fulfill({ contentType: video ? "application/octet-stream" : file[0], body, headers });
    }
    if (path.endsWith("/preview")) return route.fulfill({ status: 404, json: { code: "preview_unsupported", message: "" } });
    const sheet = sheets[path];
    if (sheet) return route.fulfill({ contentType: sheet[0], body: sheet[1] });
    const asset = assets.get(path);
    if (asset) return route.fulfill({ contentType: asset[0], body: asset[1] });
    if (path.endsWith(".woff2")) return route.fulfill({ contentType: "font/woff2", body: readFileSync(`${ui}dist${path}`) });
    return route.fulfill({ status: 404 });
  });
  await tab.goto("http://lightbox.test/");
  await tab.waitForFunction(() => !!window.preview);
  return session;
};
const show = async (tab: Page, name: string, options: { editable?: boolean; readOnly?: boolean } = {}) => {
  await tab.evaluate(([list, name, options]) => window.preview.open(list, name, options), [all, name, options] as const);
  await tab.locator("dialog.k2b-lightbox[open]").waitFor();
};
const nameShown = (tab: Page) => tab.locator(".k2b-lightbox__name b").textContent();
const actions = (tab: Page) =>
  tab
    .locator(".k2b-lightbox__actions")
    .locator("button, a")
    .evaluateAll((controls) => controls.map((control) => control.getAttribute("aria-label") ?? control.textContent?.trim()));

describe("Files in the Lightbox", () => {
  test("a README lifts its heading into the name pill; the editor is the blue Open, read-only says so", async () => {
    const { tab, errors } = await start(desktop);
    try {
      await show(tab, "README.md", { editable: true });
      await tab.waitForFunction(() => document.querySelector(".k2b-lightbox__name b")?.textContent === "Summer party 2026");
      expect(await tab.locator(".k2b-lightbox__name span").textContent()).toContain("README.md");
      expect(await actions(tab)).toEqual(["Open", "Copy text", "Share publicly", "Download", "Close"]);
      await tab.locator(".k2b-lightbox__open").click();
      expect(await tab.evaluate(() => window.preview.edits)).toEqual(["README.md"]);
      if (shots) await tab.screenshot({ path: `${shots}/files-lightbox-markdown-light-1440.png` });
      await tab.keyboard.press("Escape");
      await show(tab, "README.md", { editable: true, readOnly: true });
      await tab.getByRole("button", { name: "Open read-only" }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  test("text copies its content; Download runs Files' own download", async () => {
    const { tab } = await start(desktop);
    // The test origin is not secure, so the page gets no clipboard; a stand-in keeps what Copy writes.
    await tab.evaluate(() => {
      const copied: string[] = [];
      Object.assign(window, { copied });
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value: string) => void copied.push(value) } });
    });
    try {
      await show(tab, "Packing_list.txt");
      await tab.getByText("Stage platforms (4)").waitFor();
      await tab.getByRole("button", { name: "Copy text" }).click();
      await tab.waitForFunction(() => (window as unknown as { copied: string[] }).copied.some((value) => value.includes("Pavilion")));
      await tab.getByRole("button", { name: "Download" }).click();
      expect(await tab.evaluate(() => window.preview.downloads)).toEqual(["Packing_list.txt"]);
    } finally {
      await tab.context().close();
    }
  });

  test("a picture comes from a fresh lease; a failed lease offers Try again, which asks for a new one", async () => {
    const session = await start(desktop);
    const { tab } = session;
    try {
      session.failing.add("Poster.svg");
      await show(tab, "Poster.svg");
      await tab.getByRole("button", { name: "Try again" }).click();
      await tab.locator(".k2b-lightbox__image").waitFor();
      expect(session.leases.filter((name) => name === "Poster.svg").length).toBe(2);
      if (shots) await tab.screenshot({ path: `${shots}/files-lightbox-bild-light-1440.png` });
    } finally {
      await tab.context().close();
    }
  });

  test("a PDF draws from Files' inline address, offers a new tab, and shows its page; ← and → step through the folder", async () => {
    const { tab } = await start(desktop);
    try {
      await show(tab, "Report.pdf");
      await tab.locator('.k2b-lightbox [data-pdf-page="0"] img').waitFor();
      await tab.waitForFunction(() => document.querySelector(".k2b-lightbox__page")?.textContent === "Page 1 / 3");
      expect(await actions(tab)).toEqual(["Open in new tab", "Share publicly", "Download", "Close"]);
      if (shots) await tab.screenshot({ path: `${shots}/files-lightbox-pdf-light-1440.png` });
      await tab.locator(".k2b-lightbox__stage").focus();
      await tab.keyboard.press("ArrowLeft");
      expect(await nameShown(tab)).toBe("Poster.svg");
      await tab.keyboard.press("ArrowRight");
      await tab.keyboard.press("ArrowRight");
      expect(await nameShown(tab)).toBe("Clip.webm");
    } finally {
      await tab.context().close();
    }
  });

  test("a video streams from its lease by range requests and keeps the arrow keys for seeking", async () => {
    const session = await start(desktop);
    const { tab } = session;
    try {
      await show(tab, "Clip.webm");
      await tab.locator(".k2b-lightbox__video video").waitFor();
      await tab.waitForFunction(() => (document.querySelector<HTMLVideoElement>(".k2b-lightbox__video video")?.readyState ?? 0) >= 1);
      expect(session.media.some((request) => request.range !== null)).toBe(true);
      // → seeks in the video instead of stepping to the next file, in every engine and wherever the focus is.
      expect(await tab.evaluate(() => document.querySelector<HTMLVideoElement>(".k2b-lightbox__video video")!.currentTime)).toBe(0);
      await tab.keyboard.press("ArrowRight");
      await tab.waitForFunction(() => document.querySelector<HTMLVideoElement>(".k2b-lightbox__video video")!.currentTime > 0);
      expect(await nameShown(tab)).toBe("Clip.webm");
      await tab.keyboard.press("ArrowLeft");
      await tab.waitForFunction(() => document.querySelector<HTMLVideoElement>(".k2b-lightbox__video video")!.currentTime === 0);
      expect(await nameShown(tab)).toBe("Clip.webm");
    } finally {
      await tab.context().close();
    }
  });

  test("a file without a preview offers Download in its place", async () => {
    const { tab } = await start(desktop);
    try {
      await show(tab, "Archive.zip");
      await tab.getByText("There is no preview for this file").waitFor();
      await tab.locator(".k2b-lightbox__notice").getByRole("button", { name: "Download" }).click();
      expect(await tab.evaluate(() => window.preview.downloads)).toEqual(["Archive.zip"]);
    } finally {
      await tab.context().close();
    }
  });

  test("a phone shows the file across the screen without edge buttons", async () => {
    const { tab } = await start(phone);
    try {
      await show(tab, "Poster.svg");
      await tab.locator(".k2b-lightbox__image").waitFor();
      expect(
        await tab
          .locator(".k2b-lightbox__edge")
          .first()
          .evaluate((button) => getComputedStyle(button).display),
      ).toBe("none");
      await settled(tab);
      if (shots) await tab.screenshot({ path: `${shots}/files-lightbox-bild-light-390.png` });
    } finally {
      await tab.context().close();
    }
  });
});
