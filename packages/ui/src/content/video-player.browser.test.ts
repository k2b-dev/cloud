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
/** An iPhone reel as the camera records it by default: HEVC with AAC sound in QuickTime. */
const hevcReel = new Uint8Array(readFileSync(resolve(ui, "test/media/hevc-aac-180x320.mov")));
/**
 * The expiring lease answers at most this many bytes at a time, so Chromium needs more requests than the lease allows
 * before it has the video's metadata. Real servers answer the whole requested range, as every other route does: WebKit's
 * media stack on Linux does not ask for the rest of a shortened answer and plays on only with bytes an earlier answer
 * brought.
 */
const CHUNK = 8 * 1024;
/** Where the test video's first frames start; everything before is its header. */
const firstCluster = Buffer.from(videos.landscape!).indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));

// Starting a page and playing real media takes longer than a unit test; this is the budget of the other browser tests.
setDefaultTimeout(30_000);

const entry = resolve(import.meta.dir, "video-player.fixture.ts");
const fixtureSource = `
import { createSignal, onMount } from "solid-js";
import { createComponent, insert, render } from "solid-js/web";
import { LocaleProvider, VideoPlayer } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [options, setOptions] = createSignal(null);
const [src, setSrc] = createSignal(null);
window.renewals = 0;
window.fallbacks = 0;
// The player's own clock, which the tests move forward instead of waiting.
const now = performance.now.bind(performance);
let skipped = 0;
performance.now = () => now() + skipped;
window.skipTime = (ms) => {
  skipped += ms;
};
// Media events do not bubble, but the document sees them on their way to the video, before the player does.
window.mediaEvents = [];
for (const type of ["loadedmetadata", "loadeddata", "seeked", "canplay", "playing", "timeupdate"])
  document.addEventListener(
    type,
    (event) => {
      const video = event.target;
      window.mediaEvents.push({ type, src: video.currentSrc, time: video.currentTime, seeking: video.seeking, readyState: video.readyState });
    },
    true,
  );
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
        // A host that sets the address on mount does so before the player's own effects first run.
        if (current.srcOnMount) onMount(() => setSrc(current.srcOnMount));
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
              // RENEWAL in the address becomes the number of the renewal, so every renewal gets its own address.
              renew: current.renew
                ? async () => {
                    window.renewals += 1;
                    return current.renew.replace("RENEWAL", String(window.renewals));
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
/** Leases that answer only their first requests, as a signed URL that expires. */
const leaseLimits = new Map<string, number>([["expiring", 2]]);
const leaseUses = new Map<string, number>();
let held: Promise<void> = Promise.resolve();

const ranged = (request: Request, bytes: Uint8Array<ArrayBuffer>, path: string, chunked: boolean): Response => {
  const type = path.endsWith(".mov") ? "video/quicktime" : "video/webm";
  const headers = { "content-type": type, "accept-ranges": "bytes", "access-control-allow-origin": "*" };
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
      if (path === "/broken.mp4" || path === "/held/broken.mp4") {
        if (path.startsWith("/held/")) await held;
        requests.push({ path, range: request.headers.get("range"), status: 200 });
        return new Response("This is no video at all.", { headers: { "content-type": "video/mp4" } });
      }
      if (path === "/reel.mov") return ranged(request, hevcReel, path, false);
      // /video/<name>.webm, /held/<name>.webm, and /lease/<lease>/<name>.webm
      const match = /^\/(video|held|lease\/([a-z]+))\/([a-z]+)\.webm$/.exec(path);
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
      return ranged(request, bytes, path, lease === "expiring");
    },
  });
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type MountOptions = { src: string | null; srcOnMount?: string; host: string; ratio?: number; renew?: string; locale?: "en" | "de" };
const open = async (options: MountOptions, viewport = { width: 1024, height: 768 }, touch = false): Promise<Page> => {
  const page = await browser.newPage({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  await page.goto(server.url.href);
  await page.evaluate((next) => (window as unknown as { mount: (options: MountOptions) => void }).mount(next), {
    ...options,
    src: options.src && new URL(options.src, server.url).href,
    srcOnMount: options.srcOnMount && new URL(options.srcOnMount, server.url).href,
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
/**
 * Waits until the video shows its first frame and no seek is under way. Without a poster, the player starts the video
 * just after its beginning with a media fragment, so the engine seeks there once it has the metadata. WebKit on Linux
 * can wait for good when play() arrives during that seek: after the seek it reports `playing`, then `waiting` and
 * `stalled` at readyState 2, and the video never moves. A test that plays or seeks waits for this first.
 */
const firstFrame = (page: Page) =>
  page.waitForFunction(() => {
    const video = document.querySelector(".k2b-video-player__video") as HTMLVideoElement | null;
    return video !== null && !video.seeking && video.readyState >= 2;
  });
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

  test("an address the host sets on mount plays", async () => {
    const page = await open({ src: null, srcOnMount: "/video/portrait.webm", host: "width:640px;height:360px" });
    try {
      await metadata(page);
      expect((await state(page)).src).toContain("/video/portrait.webm");
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
    const page = await open({ src: "/video/landscape.webm", host: "width:640px;height:360px" });
    try {
      await firstFrame(page);
      // The video plays at its own speed: WebKit on Linux changes the speed with a seek, which can leave it waiting for good.
      await page.$eval(".k2b-video-player__video", (element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        return video.play();
      });
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).ended, undefined, {
        timeout: 15_000,
      });
      const media = requests.filter((request) => request.path === "/video/landscape.webm");
      // A 206 answer brought the frames, not only the index at the end: Chromium asks for the whole video by range,
      // WebKit for everything from the first frames once it has read the index.
      const start = (range: string | null) => Number(/^bytes=(\d+)-/.exec(range ?? "")?.[1]);
      expect(media.some((request) => request.status === 206 && start(request.range) <= firstCluster)).toBe(true);
      expect(media.every((request) => request.status === 200 || request.status === 206)).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("the keyboard plays, pauses, seeks, and mutes the focused video in every engine", async () => {
    const page = await open({ src: "/video/landscape.webm", host: "width:640px;height:360px" });
    try {
      await firstFrame(page);
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
      // Screen readers announce it.
      expect(await page.getAttribute(".k2b-video-player__fallback", "role")).toBe("alert");
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

  test("when the focused video fails, focus moves to the fallback's action", async () => {
    let release = () => {};
    held = new Promise<void>((done) => {
      release = done;
    });
    const page = await open({ src: "/held/broken.mp4", host: "width:640px;height:360px" });
    try {
      await page.focus(".k2b-video-player__video");
      release();
      await page.waitForSelector(".k2b-video-player__fallback");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("href"))).toBe("/download");
    } finally {
      held = Promise.resolve();
      await page.close();
    }
  });

  test("a reel whose picture the browser cannot decode falls back instead of playing its sound in an empty frame", async () => {
    const page = await open({ src: "/reel.mov", renew: "/reel.mov?RENEWAL", host: "width:640px;height:360px" });
    try {
      // Safari decodes HEVC; Chromium without a platform decoder plays only the sound.
      const decodes = await page.evaluate(() => document.createElement("video").canPlayType('video/mp4; codecs="hvc1"') !== "");
      if (decodes) {
        await metadata(page);
        const size = await page.$eval(".k2b-video-player__video", (element) => {
          const video = element as HTMLVideoElement;
          return [video.videoWidth, video.videoHeight];
        });
        expect(size).toEqual([180, 320]);
        expect(await counters(page)).toEqual({ renewals: 0, fallbacks: 0 });
      } else {
        await page.waitForSelector(".k2b-video-player__fallback");
        expect(await page.$(".k2b-video-player__video")).toBeNull();
        // A fresh address does not teach the browser a codec.
        expect(await counters(page)).toEqual({ renewals: 0, fallbacks: 1 });
      }
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

  test("an address that expires while the video loads is renewed, and the renewed address plays to the end", async () => {
    leaseUses.clear();
    const page = await open({
      src: "/lease/expiring/landscape.webm",
      renew: "/lease/fresh/landscape.webm",
      host: "width:640px;height:360px",
    });
    try {
      // Both engines need more answers than the lease gives before they show the first frame: Chromium for the metadata,
      // WebKit for its seek to that frame. The test plays once the renewed address shows that frame, so its play()
      // overlaps neither the switch of the address, which aborts a pending play(), nor the player's seeks.
      await page.waitForFunction(() => {
        const video = document.querySelector(".k2b-video-player__video") as HTMLVideoElement | null;
        const events = (window as unknown as { mediaEvents: { type: string; src: string }[] }).mediaEvents;
        const shown = events.some((event) => event.type === "seeked" && event.src.includes("/lease/fresh/"));
        return video !== null && video.currentSrc.includes("/lease/fresh/") && !video.seeking && shown;
      });
      await page.$eval(".k2b-video-player__video", (element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        return video.play();
      });
      await page.waitForFunction(() => (document.querySelector(".k2b-video-player__video") as HTMLVideoElement).ended, undefined, {
        timeout: 15_000,
      });
      expect(await counters(page)).toEqual({ renewals: 1, fallbacks: 0 });
      expect(leaseUses.get("expiring")).toBeGreaterThan(2);
    } finally {
      await page.close();
    }
  });

  test("an address that expires during playback is renewed and playback continues where it stopped", async () => {
    const page = await open({
      src: "/video/landscape.webm",
      renew: "/video/landscape.webm?renewal=RENEWAL",
      host: "width:640px;height:360px",
    });
    try {
      await firstFrame(page);
      // The engines fetch this short video whole while it loads, so a real expiry could not happen this late. The video
      // element's own error event is what an expired address causes, here at the first second of playback. The page
      // fails it in the same task that reads the time, so no round trip from the test adds to the delay. A page that
      // runs no task for the two seconds the video still plays would fail it only at the end.
      const stopped = await page.$eval(".k2b-video-player__video", (element) => {
        const video = element as HTMLVideoElement;
        video.muted = true;
        return new Promise<number>((resolve, reject) => {
          video.addEventListener("timeupdate", function expire() {
            if (video.currentTime < 1) return;
            video.removeEventListener("timeupdate", expire);
            resolve(video.currentTime);
            video.dispatchEvent(new Event("error"));
          });
          video.play().catch(reject);
        });
      });
      // Nobody presses play again: the renewed address plays by itself. The test waits until it plays, not until it
      // ends: on a heavily loaded machine, Linux WebKit's media engine can stop for good after it starts in the middle
      // of a video, also in a bare video element without the player.
      await page.waitForFunction(() =>
        (window as unknown as { mediaEvents: { type: string; src: string }[] }).mediaEvents.some(
          (event) => event.type === "playing" && event.src.includes("renewal=1"),
        ),
      );
      expect(await counters(page)).toEqual({ renewals: 1, fallbacks: 0 });
      expect((await state(page)).src).toContain("renewal=1");
      const events = await page.evaluate(
        () => (window as unknown as { mediaEvents: { type: string; src: string; time: number; readyState: number }[] }).mediaEvents,
      );
      const renewed = events.filter((event) => event.src.includes("renewal=1"));
      // It plays from the point where the first address stopped and never showed a frame before it: the renewed
      // address starts there instead of starting over and seeking back.
      expect(renewed.find((event) => event.type === "playing")?.time).toBeGreaterThanOrEqual(stopped - 0.05);
      expect(renewed.filter((event) => event.readyState >= 2 && event.time < stopped - 0.05)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  /**
   * The viewer pauses at 1.5 s, and the address expires during the pause. Each failure is the video element's own error
   * event, so the player sees what an expired address causes, at exactly the point it chooses.
   */
  const renewWhilePaused = async (renew = "/video/landscape.webm?renewal=RENEWAL") => {
    const page = await open({
      src: "/video/landscape.webm",
      renew,
      host: "width:640px;height:360px",
    });
    // The viewer seeks once the first frame shows: WebKit drops a seek that arrives while the player's own one to that
    // frame is under way.
    await firstFrame(page);
    await page.$eval(".k2b-video-player__video", (element) => {
      const video = element as HTMLVideoElement;
      video.muted = true;
      video.currentTime = 1.5;
    });
    await expireAt(page, 1);
    return page;
  };
  /** Fails the address once the video shows 1.5 s and waits until renewal number `renewal` shows that point again. */
  const expireAt = async (page: Page, renewal: number) => {
    await page.waitForFunction(() => {
      const video = document.querySelector(".k2b-video-player__video") as HTMLVideoElement;
      return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 1.5) < 0.05;
    });
    await page.$eval(".k2b-video-player__video", (video) => video.dispatchEvent(new Event("error")));
    await page.waitForFunction(
      (renewal) =>
        (window as unknown as { mediaEvents: { src: string; time: number; seeking: boolean; readyState: number }[] }).mediaEvents.some(
          (event) =>
            event.src.includes(`renewal=${renewal}`) && !event.seeking && event.readyState >= 2 && Math.abs(event.time - 1.5) < 0.05,
        ),
      renewal,
    );
  };

  test("an address renewed during a pause is renewed again when it expires during the next pause", async () => {
    const page = await renewWhilePaused();
    try {
      // The renewed address held for longer than any video takes to fail again by itself.
      await page.evaluate(() => (window as unknown as { skipTime: (ms: number) => void }).skipTime(60_000));
      await expireAt(page, 2);
      expect(await counters(page)).toEqual({ renewals: 2, fallbacks: 0 });
      expect(await state(page)).toMatchObject({ paused: true, time: 1.5 });
      // The twice renewed address plays: play() resolves once it does.
      await page.$eval(".k2b-video-player__video", (element) => (element as HTMLVideoElement).play());
    } finally {
      await page.close();
    }
  });

  test("a renewed address that fails right after it showed its point falls back instead of renewing again", async () => {
    const page = await renewWhilePaused();
    try {
      await page.$eval(".k2b-video-player__video", (video) => video.dispatchEvent(new Event("error")));
      await page.waitForSelector(".k2b-video-player__fallback");
      expect(await counters(page)).toEqual({ renewals: 1, fallbacks: 1 });
    } finally {
      await page.close();
    }
  });

  test("a renewed address that brings a media fragment of its own also continues where the video stopped", async () => {
    // A host may hand out addresses with a fragment of their own. WebKit would start this one at its 0.001 s, not at the
    // point where the video stopped.
    const page = await renewWhilePaused("/video/landscape.webm?renewal=RENEWAL#t=0.001");
    try {
      expect(await state(page)).toMatchObject({ paused: true, time: 1.5 });
      const events = await page.evaluate(
        () => (window as unknown as { mediaEvents: { src: string; time: number; readyState: number }[] }).mediaEvents,
      );
      expect(events.filter((event) => event.src.includes("renewal=1") && event.readyState >= 2 && event.time < 1.45)).toEqual([]);
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
