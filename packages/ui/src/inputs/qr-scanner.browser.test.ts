import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { qr } from "@k2b/stdlib/qr";
import { type Browser, type BrowserContextOptions, devices, type Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Which engine qr-scanner picks, how it reports frames, and what getUserMedia answers only show in a real browser,
// so the shipped browser build scans here with the real qr-scanner.
const ui = resolve(import.meta.dir, "../..");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "qr-scanner.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { QrScanner } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const calls = (globalThis.scanner = { results: [], errors: [], stops: 0 });
render(
  () =>
    createComponent(QrScanner, {
      onResult: (text) => {
        calls.results.push(text);
        return true;
      },
      onStop: () => calls.stops++,
      onError: (reason) => calls.errors.push(reason),
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the QR scanner fixture for the browser.");
const script = await build.outputs[0]!.text();

const CODE = "https://cloud.example/pair#code";
// The QR modules as one SVG path, with the module count of its view box, for a camera that films the code.
const svg = qr.toSvg(CODE);
const code = { text: CODE, path: /<path d="([^"]+)"/.exec(svg)![1]!, size: Number(/viewBox="-4 -4 (\d+)/.exec(svg)![1]) - 8 };

type Detector = "none" | "empty" | "reject" | "transient" | "broken";
type Camera = "fake" | "code" | "turning" | "rear-overconstrained" | "NotReadableError" | "NotAllowedError" | "NotFoundError";
/** How the first play() of the page ends: as usual, refused, as WebKit may refuse it, or never, as a stalled player. */
type Play = "normal" | "refuse" | "hang";
type Calls = { results: string[]; errors: string[]; stops: number };
type Probe = { scanner: Calls; detects: number; requests: MediaTrackConstraints[]; codeVisible: boolean; turned: boolean };

/**
 * Stands in for the parts a phone decides: the native BarcodeDetector of Chrome for Android, which answers an empty
 * frame with no barcodes, a camera that films the code, turns with the device, or refuses with the error a browser
 * gives, a player that refuses or never starts the picture, and a browser that cannot start the decoder worker.
 */
function stubDevice({
  detector,
  camera,
  play,
  blockWorker,
  code,
}: {
  detector: Detector;
  camera: Camera;
  play: Play;
  blockWorker: boolean;
  code: { text: string; path: string; size: number };
}) {
  const probe = globalThis as unknown as Probe;
  probe.detects = 0;
  probe.requests = [];
  probe.codeVisible = false;
  probe.turned = false;
  if (play !== "normal") {
    const original = HTMLMediaElement.prototype.play;
    let first = true;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (!first) return original.call(this);
      first = false;
      return play === "refuse" ? Promise.reject(new DOMException("Playback needs a gesture.", "NotAllowedError")) : new Promise(() => {});
    };
  }
  if (detector !== "none") {
    Object.defineProperty(globalThis, "BarcodeDetector", {
      configurable: true,
      value: class {
        static async getSupportedFormats() {
          if (detector === "broken") throw new DOMException("Barcode detection is unavailable.", "NotSupportedError");
          return ["qr_code"];
        }
        async detect() {
          const count = ++probe.detects;
          if (detector === "reject") throw new DOMException("Unsupported source.", "NotSupportedError");
          if (detector === "transient" && count === 1) throw new DOMException("The image could not be read.", "InvalidStateError");
          if (!probe.codeVisible) return [];
          const corners = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ];
          return [
            {
              rawValue: code.text,
              format: "qr_code",
              cornerPoints: corners,
              boundingBox: new DOMRectReadOnly(0, 0, 1, 1),
            },
          ];
        }
      },
    });
  }
  if (blockWorker) {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class {
        constructor() {
          throw new DOMException("The worker could not start.", "SecurityError");
        }
      },
    });
  }
  if (camera === "fake") return;
  const film = async () => {
    const canvas = document.createElement("canvas");
    // A turning camera films landscape until the device turns, then portrait.
    canvas.width = 640;
    canvas.height = camera === "turning" ? 360 : 640;
    const context = canvas.getContext("2d")!;
    const modules = new Path2D(code.path);
    const draw = () => {
      if (camera === "turning" && probe.turned && canvas.width !== 360) [canvas.width, canvas.height] = [360, 640];
      const { width, height } = canvas;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      // The turning camera films the code only once the test shows it.
      if (camera === "turning" && !probe.codeVisible) return;
      // A code in the middle with a white quiet zone, as a phone held over a screen sees it.
      const side = Math.min(width, height) / 2;
      const scale = side / code.size;
      context.setTransform(scale, 0, 0, scale, (width - side) / 2, (height - side) / 2);
      context.fillStyle = "#000";
      context.fill(modules);
    };
    const stream = canvas.captureStream(20);
    // A canvas stream sends a frame after each paint.
    draw();
    setInterval(draw, 50);
    // A real camera resolves getUserMedia once it delivers frames. WebKit's player can stall on a stream that has
    // none yet, so hand it over after the rendering update that captures the first paint.
    await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
    return stream;
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async ({ video }: MediaStreamConstraints) => {
        const request = typeof video === "object" ? video : {};
        probe.requests.push(request);
        if (camera === "code" || camera === "turning") return film();
        if (camera === "rear-overconstrained") {
          if (request.facingMode) throw new DOMException("No rear camera.", "OverconstrainedError");
          return film();
        }
        throw new DOMException("The camera refused.", camera);
      },
    },
  });
}

const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  // Chromium films a generated picture as the camera and grants access without a prompt.
  browser = await launchBrowser(
    browserName === "chromium" ? { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } : {},
  );
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

async function open(options: {
  detector: Detector;
  camera: Camera;
  context?: BrowserContextOptions;
  play?: Play;
  blockWorker?: boolean;
}): Promise<Page> {
  const context = await browser.newContext(options.context ?? phone);
  await context.addInitScript(stubDevice, {
    detector: options.detector,
    camera: options.camera,
    play: options.play ?? "normal",
    blockWorker: options.blockWorker ?? false,
    code,
  });
  // getUserMedia needs a secure context, so the page has an https address.
  await context.route("https://scanner.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta charset="utf-8"></head><body class="k2b-ui"><main id="app"></main></body></html>',
    }),
  );
  const page = await context.newPage();
  await page.goto("https://scanner.test/");
  await page.addScriptTag({ content: script });
  return page;
}

const probe = (page: Page) =>
  page.evaluate(() => {
    const { detects, requests } = globalThis as unknown as Probe;
    return { detects, requests };
  });
const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as Probe).scanner);
/** Waits until the scanner reports a code or an error. */
const settled = (page: Page) =>
  page.waitForFunction(
    () => {
      const { results, errors } = (globalThis as unknown as Probe).scanner;
      return results.length + errors.length > 0;
    },
    undefined,
    { timeout: 15_000 },
  );
const status = (page: Page) => page.locator('[role="status"]').textContent();

describe("@k2b/ui QrScanner in a browser", () => {
  // Chromium alone films a fake camera; WebKit has no BarcodeDetector either, so Safari never takes this path.
  test.skipIf(browserName === "webkit")(
    "keeps scanning through the empty frames of Chrome for Android's BarcodeDetector, then reads the code",
    async () => {
      const page = await open({ detector: "empty", camera: "fake", context: { ...devices["Pixel 7"], permissions: ["camera"] } });
      try {
        await page.waitForFunction(() => (globalThis as unknown as Probe).detects >= 30, undefined, { timeout: 15_000 });
        expect(await calls(page)).toEqual({ results: [], errors: [], stops: 0 });
        expect(await status(page)).toBe("Point the camera at a QR code.");
        expect(await page.locator("video").evaluate((video: HTMLVideoElement) => !video.paused && video.srcObject !== null)).toBe(true);
        await page.evaluate(() => {
          (globalThis as unknown as Probe).codeVisible = true;
        });
        await settled(page);
        expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
        // An accepted code stops the camera.
        expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      } finally {
        await page.context().close();
      }
    },
    30_000,
  );

  test("falls back to the worker when the BarcodeDetector cannot read at all", async () => {
    const page = await open({ detector: "reject", camera: "code" });
    try {
      await settled(page);
      expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
      // The native detector was tried, and the code was read by the worker, since the detector never returns one.
      expect((await probe(page)).detects).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("a detector error on one frame neither stops nor fails the camera; the worker reads on for the page", async () => {
    const page = await open({ detector: "transient", camera: "code" });
    try {
      await settled(page);
      expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
      // The stub detector never returns the code: the worker read it, and the detector was not asked again.
      expect((await probe(page)).detects).toBe(1);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("reads a code with the worker where no BarcodeDetector exists, as on iPhone", async () => {
    const page = await open({ detector: "none", camera: "code" });
    try {
      await settled(page);
      expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
      expect((await probe(page)).requests).toEqual([{ width: { min: 1024 }, facingMode: { exact: "environment" } }]);
      expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.style.transform)).not.toBe("scaleX(-1)");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("takes any camera when no rear camera fits, and mirrors it", async () => {
    const page = await open({ detector: "none", camera: "rear-overconstrained" });
    try {
      await page.waitForFunction(() => document.querySelector("video")?.srcObject != null);
      expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.style.transform)).toBe("scaleX(-1)");
      await settled(page);
      expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
      expect((await probe(page)).requests).toEqual([
        { width: { min: 1024 }, facingMode: { exact: "environment" } },
        { width: { min: 768 }, facingMode: { exact: "environment" } },
        { facingMode: { exact: "environment" } },
        { width: { min: 1024 } },
      ]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  // The engine scans from its play event and places its frame from the picture's size, so a player that never plays
  // leaves a black preview with a stray frame (#1994). The scanner offers to start the picture again instead.
  for (const [play, story] of [
    ["refuse", "the browser refuses to play it"],
    ["hang", "the player never starts it"],
  ] as const) {
    test(`offers to start the camera picture again when ${story}, then reads the code`, async () => {
      const page = await open({ detector: "none", camera: "code", play });
      try {
        const retry = page.getByRole("button", { name: "Try again" });
        await retry.waitFor({ timeout: 10_000 });
        expect(await status(page)).toBe("The camera is on, but its picture did not start.");
        expect(await calls(page)).toEqual({ results: [], errors: [], stops: 0 });
        await retry.click();
        await settled(page);
        expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  test("keeps the scan frame centred on the picture when the camera turns with the device, then reads the code", async () => {
    const page = await open({ detector: "none", camera: "turning" });
    /**
     * How far the scan frame sits from the centre of the preview, as a share of its size, and its smaller side. The test
     * page has no stylesheet, so the video stretches the picture over its box rather than covering a square.
     */
    const frame = () =>
      page.evaluate(() => {
        const video = document.querySelector("video")!.getBoundingClientRect();
        const overlay = document.querySelector<HTMLElement>(".scan-region-highlight")!.getBoundingClientRect();
        return {
          x: (overlay.left + overlay.width / 2 - video.left) / video.width - 0.5,
          y: (overlay.top + overlay.height / 2 - video.top) / video.height - 0.5,
          side: Math.min(overlay.width / video.width, overlay.height / video.height),
        };
      });
    const offCentre = ({ x, y, side }: Awaited<ReturnType<typeof frame>>) => Math.abs(x) > 0.005 || Math.abs(y) > 0.005 || side < 1 / 3;
    /** qr-scanner places the frame in an animation frame after the event, so the frame gets a second to settle. */
    const expectCentred = async () => {
      for (let tries = 0; tries < 20 && offCentre(await frame()); tries++) await page.waitForTimeout(50);
      const { x, y, side } = await frame();
      expect(x).toBeCloseTo(0, 2);
      expect(y).toBeCloseTo(0, 2);
      // qr-scanner scans the middle two thirds of the picture's smaller side; a frame of no size was placed too early.
      expect(side).toBeGreaterThan(1 / 3);
    };
    try {
      await page.getByText("Point the camera at a QR code.").waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => document.querySelector("video")!.videoWidth === 640);
      await expectCentred();
      // The device turns: the window turns to landscape and the camera films portrait.
      await page.evaluate(() => {
        (globalThis as unknown as Probe).turned = true;
      });
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => document.querySelector("video")!.videoWidth === 360);
      await expectCentred();
      await page.evaluate(() => {
        (globalThis as unknown as Probe).codeVisible = true;
      });
      await settled(page);
      expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
    } finally {
      await page.context().close();
    }
  }, 30_000);

  for (const [camera, reason, requests] of [
    ["NotAllowedError", "denied", 1],
    ["NotReadableError", "in-use", 6],
    ["NotFoundError", "no-camera", 6],
  ] as const) {
    test(`reports ${camera} from the camera as "${reason}"`, async () => {
      const page = await open({ detector: "none", camera });
      try {
        await settled(page);
        expect(await calls(page)).toEqual({ results: [], errors: [reason], stops: 0 });
        // Only a refusal ends the search, since asking again could show the permission prompt again.
        expect((await probe(page)).requests.length).toBe(requests);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }

  for (const [story, detector, blockWorker] of [
    ["the browser's detector cannot start", "broken", false],
    ["the detector fails, then the worker cannot start", "reject", true],
  ] as const) {
    test(`stops the camera and reports "unavailable" when no scanning engine loads: ${story}`, async () => {
      const page = await open({ detector, camera: "code", blockWorker });
      try {
        await settled(page);
        expect(await calls(page)).toEqual({ results: [], errors: ["unavailable"], stops: 0 });
        expect(await page.locator("video").evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});
