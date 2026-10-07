import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Range requests, decoding, the frame's geometry, and the engines' own keyboard handling only exist in a real
// browser. A real HTTP server answers the media requests, so the engine's media stack sees genuine 206 responses.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const videos: Record<string, Uint8Array<ArrayBuffer>> = {
  landscape: new Uint8Array(readFileSync(resolve(ui, "test/media/landscape-320x180.webm"))),
  portrait: new Uint8Array(readFileSync(resolve(ui, "test/media/portrait-180x320.webm"))),
};
/**
 * A chunked answer carries at most this many bytes, so playing a test video takes several range requests. Real servers
 * answer the whole requested range; WebKit's media stack cannot seek against shortened answers.
 */
const CHUNK = 8 * 1024;

// Starting a page and playing real media takes longer than a unit test; this is the budget of the other browser tests.
setDefaultTimeout(30_000);

const entry = resolve(import.meta.dir, "video-player.fixture.ts");
const fixtureSource = `
import { createSignal } from "solid-js";
import { createComponent, insert, render } from "solid-js/web";
import { LocaleProvider, VideoPlayer } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [options, setOptions] = createSignal(null);
const [src, setSrc] = createSignal(null);
window.renewals = 0;
window.fallbacks = 0;
window.mount = (next) => {
  setSrc(next.src);
  setOptions(next);
};
window.setSrc = setSrc;
render(
  () =>
    createComponent(LocaleProvider, {
      get locale() { return options()?.locale ?? "en"; },
      get children() {
        const current = options();
        if (!current) return null;
        const host = document.createElement("div");
        host.id = "host";
        host.setAttribute("style", current.host);
        insert(
          host,
          () =>
            createComponent(VideoPlayer, {
              get src() {
                return src();
              },
              label: "Reel for approval",
              ratio: current.ratio,
              crossOrigin: current.crossOrigin,
              renew: current.renew
                ? async () => {
                    window.renewals += 1;
                    return current.renew;
                  }
                : undefined,
              onFallback: () => {
                window.fallbacks += 1;
              },
              fallbackAction: (() => {
                const link = document.createElement("a");
                link.href = "/download";
                link.textContent = "Download";
                return link;
              })(),
            }),
        );
        return host;
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixtureSource },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the VideoPlayer fixture for the browser.");
const script = await build.outputs[0]!.text();

type Logged = { path: string; range: string | null; status: number };
const requests: Logged[] = [];
/** Leases that answer only their first requests, as a signed URL that expires during playback. */
const leaseLimits = new Map<string, number>([["expiring", 2]]);
const leaseUses = new Map<string, number>();
let held: Promise<void> = Promise.resolve();

const ranged = (request: Request, bytes: Uint8Array<ArrayBuffer>, path: string, chunked: boolean): Response => {
  const headers = { "content-type": "video/webm", "accept-ranges": "bytes", "access-control-allow-origin": "*" };
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!match) {
    requests.push({ path, range: null, status: 200 });
    return new Response(bytes, { headers });
  }
  const start = Number(match[1]);
  if (start >= bytes.length) {
    requests.push({ path, range: match[0], status: 416 });
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${bytes.length}` } });
  }
  const end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, chunked ? start + CHUNK - 1 : bytes.length - 1, bytes.length - 1);
  requests.push({ path, range: match[0], status: 206 });
  return new Response(bytes.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}` },
  });
};

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/")
        return new Response(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
            `<link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0"><div id="app"></div><script src="/fixture.js"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (path === "/broken.mp4") {
        requests.push({ path, range: request.headers.get("range"), status: 200 });
        return new Response("This is no video at all.", { headers: { "content-type": "video/mp4" } });
      }
      // /video/<name>.webm, /chunked/<name>.webm, /held/<name>.webm, and /lease/<lease>/<name>.webm, which is chunked
      const match = /^\/(video|chunked|held|lease\/([a-z]+))\/([a-z]+)\.webm$/.exec(path);
      const bytes = match ? videos[match[3]!] : undefined;
      if (!match || !bytes) return new Response("Not found", { status: 404 });
      if (match[1] === "held") await held;
      const lease = match[2];
      if (lease) {
        const uses = (leaseUses.get(lease) ?? 0) + 1;
        leaseUses.set(lease, uses);
        if (uses > (leaseLimits.get(lease) ?? Number.POSITIVE_INFINITY)) {
          requests.push({ path, range: request.headers.get("range"), status: 403 });
          return new Response("Lease expired", { status: 403 });
        }
      }
      return ranged(request, bytes, path, match[1] === "chunked" || Boolean(lease));
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type MountOptions = { src: string | null; host: string; ratio?: number; renew?: string; locale?: "en" | "de" };
const open = async (options: MountOptions, viewport = { width: 1024, height: 768 }, touch = false): Promise<Page> => {
  const page = await browser.newPage({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  await page.goto(server.url.href);
  await page.evaluate((next) => (window as unknown as { mount: (options: MountOptions) => void }).mount(next), {
    ...options,
    src: options.src && new URL(options.src, server.url).href,
    renew: options.renew && new URL(options.renew, server.url).href,
  });
  await page.waitForSelector(".k2b-video-player");
  return page;
};
type Box = { width: number; height: number; left: number; top: number };
const box = (page: Page, selector: string): Promise<Box> =>
  page.$eval(selector, (element) => {
    const rect = element.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height), left: Math.round(rect.left), top: Math.round(rect.top) };
  });
const metadata = (page: Page) =>
  page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement | null)?.readyState! >= 1);
const state = (page: Page) =>
  page.$eval(".k2b-video-player__video", (element) => {
    const video = element as HTMLVideoElement;
    return { paused: video.paused, time: video.currentTime, muted: video.muted, ended: video.ended, src: video.currentSrc };
  });
const counters = (page: Page) =>
  page.evaluate(() => {
    const { renewals, fallbacks } = window as unknown as { renewals: number; fallbacks: number };
    return { renewals, fallbacks };
  });

describe(`VideoPlayer (${browserName})`, () => {
  test("a portrait reel fills the frame's height uncropped, and the frame does not move while it loads", async () => {
    let release = () => {};
    held = new Promise<void>((done) => {
      release = done;
    });
    const page = await open({ src: "/held/portrait.webm", host: "width:640px;height:360px" });
    try {
      const before = await box(page, ".k2b-video-player");
      expect(before).toMatchObject({ width: 640, height: 360 });
      release();
      await metadata(page);
      expect(await box(page, ".k2b-video-player")).toEqual(before);
      // The element covers the whole frame and the picture fits inside it: a 9:16 picture 360 px tall, centred.
      expect(await box(page, ".k2b-video-player__video")).toEqual(before);
      const fit = await page.$eval(".k2b-video-player__video", (element) => {
        const video = element as HTMLVideoElement;
        return { fit: getComputedStyle(video).objectFit, width: video.videoWidth, height: video.videoHeight };
      });
      expect(fit).toEqual({ fit: "contain", width: 180, height: 320 });
    } finally {
      held = Promise.resolve();
      await page.close();
    }
  });

  test("a frame whose address is still on its way shows loading at its final size", async () => {
    const page = await open({ src: null, host: "width:640px;height:360px" });
    try {
      const frame = await box(page, ".k2b-video-player");
      expect(frame).toMatchObject({ width: 640, height: 360 });
      expect(await page.getAttribute(".k2b-video-player__fallback", "role")).toBe("status");
      await page.evaluate(
        (href) => (window as unknown as { setSrc: (src: string) => void }).setSrc(href),
        new URL("/video/portrait.webm", server.url).href,
      );
      await metadata(page);
      expect(await box(page, ".k2b-video-player")).toEqual(frame);
      expect(await page.$(".k2b-video-player__fallback")).toBeNull();
    } finally {
      await page.close();
    }
  });

  test("where the host leaves the height open, the frame keeps its ratio before and after the video loads", async () => {
    const page = await open({ src: "/video/portrait.webm", host: "width:360px" });
    try {
      const wide = await box(page, ".k2b-video-player");
      expect(wide).toMatchObject({ width: 360, height: Math.round((360 * 9) / 16) });
      await metadata(page);
      expect(await box(page, ".k2b-video-player")).toEqual(wide);
      await page.evaluate(() =>
        (window as unknown as { mount: (options: object) => void }).mount({
          src: new URL("/video/portrait.webm", location.href).href,
          host: "width:360px",
          ratio: 9 / 16,
        }),
      );
      await page.waitForFunction(() => document.querySelector<HTMLElement>(".k2b-video-player")!.getBoundingClientRect().height > 600);
      expect(await box(page, ".k2b-video-player")).toMatchObject({ width: 360, height: 640 });
    } finally {
      await page.close();
    }
  });

  test("plays to the end through range requests answered with 206", async () => {
    requests.length = 0;
    const page = await open({ src: "/chunked/landscape.webm", host: "width:640px;height:360px" });
    try {
      await metadata(page);
      await page.$eval(".k2b-video-player__video", (element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        video.playbackRate = 2;
        return video.play();
      });
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).ended, undefined, {
        timeout: 15_000,
      });
      const media = requests.filter((request) => request.path === "/chunked/landscape.webm");
      const partial = media.filter((request) => request.status === 206);
      // The test video is larger than one answer, so the engine had to ask for the rest by range.
      expect(partial.length).toBeGreaterThanOrEqual(Math.ceil(videos.landscape!.length / CHUNK) - 1);
      expect(partial.some((request) => request.range !== "bytes=0-")).toBe(true);
      expect(media.every((request) => request.status === 200 || request.status === 206)).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("the keyboard plays, pauses, seeks, and mutes the focused video in every engine", async () => {
    const page = await open({ src: "/video/landscape.webm", host: "width:640px;height:360px" });
    try {
      await metadata(page);
      await page.$eval(".k2b-video-player__video", (element) => {
        (element as HTMLVideoElement).muted = true;
        (element as HTMLElement).focus();
      });
      await page.keyboard.press("Space");
      await page.waitForFunction(() => !(document.querySelector(".k2b-video-player__video") as HTMLVideoElement).paused);
      await page.keyboard.press("Space");
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).paused);
      // One press is one toggle: the engine's own handling of Space does not toggle a second time.
      await page.waitForTimeout(150);
      expect((await state(page)).paused).toBe(true);
      await page.$eval(".k2b-video-player__video", (element) => {
        (element as HTMLVideoElement).currentTime = 0.5;
      });
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).currentTime >= 2.9);
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).currentTime === 0);
      await page.keyboard.press("m");
      expect((await state(page)).muted).toBe(false);
      await page.keyboard.press("k");
      await page.waitForFunction(() => !(document.querySelector(".k2b-video-player__video") as HTMLVideoElement).paused);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Reel for approval");
      // Focus rings the frame, which clips the video.
      const outline = await page.$eval(".k2b-video-player", (frame) => getComputedStyle(frame).outlineStyle);
      expect(outline).toBe("solid");
    } finally {
      await page.close();
    }
  });

  test("a video the browser cannot play shows the fallback with its action in the same frame", async () => {
    const page = await open({ src: "/broken.mp4", host: "width:640px;height:360px" });
    try {
      await page.waitForSelector(".k2b-video-player__fallback");
      expect(await box(page, ".k2b-video-player")).toMatchObject({ width: 640, height: 360 });
      expect(await page.$eval(".k2b-video-player__fallback", (element) => (element as HTMLElement).innerText)).toContain(
        "This video cannot play here",
      );
      expect(await page.getAttribute(".k2b-video-player__fallback a", "href")).toBe("/download");
      expect(await page.$(".k2b-video-player__video")).toBeNull();
      expect(await counters(page)).toEqual({ renewals: 0, fallbacks: 1 });
    } finally {
      await page.close();
    }
  });

  test("an unplayable video asks for one fresh address before it falls back", async () => {
    const page = await open({ src: "/broken.mp4", renew: "/broken.mp4?renewed", host: "width:640px;height:360px" });
    try {
      await page.waitForSelector(".k2b-video-player__fallback");
      expect(await counters(page)).toEqual({ renewals: 1, fallbacks: 1 });
    } finally {
      await page.close();
    }
  });

  test("an address that expires during playback is renewed and playback continues where it stopped", async () => {
    leaseUses.clear();
    const page = await open({
      src: "/lease/expiring/landscape.webm",
      renew: "/lease/fresh/landscape.webm",
      host: "width:640px;height:360px",
    });
    try {
      await metadata(page);
      await page.$eval(".k2b-video-player__video", (element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        video.playbackRate = 2;
        return video.play();
      });
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).ended, undefined, {
        timeout: 20_000,
      });
      expect(await counters(page)).toEqual({ renewals: 1, fallbacks: 0 });
      expect((await state(page)).src).toContain("/lease/fresh/landscape.webm");
      expect(leaseUses.get("expiring")).toBeGreaterThan(2);
    } finally {
      await page.close();
    }
  });

  test("a reel fills a phone screen from edge to edge", async () => {
    const page = await open(
      { src: "/video/portrait.webm", host: "width:100vw;height:100dvh", locale: "de" },
      { width: 390, height: 844 },
      true,
    );
    try {
      await metadata(page);
      expect(await box(page, ".k2b-video-player")).toEqual({ width: 390, height: 844, left: 0, top: 0 });
      expect(await box(page, ".k2b-video-player__video")).toEqual({ width: 390, height: 844, left: 0, top: 0 });
    } finally {
      await page.close();
    }
  });

  test("the fallback speaks German in a German page", async () => {
    const page = await open({ src: "/broken.mp4", host: "width:320px;height:180px", locale: "de" }, { width: 390, height: 844 }, true);
    try {
      await page.waitForSelector(".k2b-video-player__fallback");
      const text = await page.$eval(".k2b-video-player__fallback", (element) => (element as HTMLElement).innerText);
      expect(text).toContain("Dieses Video kann hier nicht abgespielt werden");
      // A small frame scrolls its fallback instead of growing.
      expect(await box(page, ".k2b-video-player")).toMatchObject({ width: 320, height: 180 });
    } finally {
      await page.close();
    }
  });
});
