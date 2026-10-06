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

type Detector = "none" | "empty" | "reject" | "transient";
type Camera = "fake" | "code" | "rear-overconstrained" | "NotReadableError" | "NotAllowedError" | "NotFoundError";
type Calls = { results: string[]; errors: string[]; stops: number };
type Probe = { scanner: Calls; detects: number; requests: MediaTrackConstraints[]; codeVisible: boolean };

/**
 * Stands in for the parts a phone decides: the native BarcodeDetector of Chrome for Android, which answers an empty
 * frame with no barcodes, and a camera that films the code or refuses with the error a browser gives.
 */
function stubDevice({
  detector,
  camera,
  code,
}: {
  detector: Detector;
  camera: Camera;
  code: { text: string; path: string; size: number };
}) {
  const probe = globalThis as unknown as Probe;
  probe.detects = 0;
  probe.requests = [];
  probe.codeVisible = false;
  if (detector !== "none") {
    Object.defineProperty(globalThis, "BarcodeDetector", {
      configurable: true,
      value: class {
        static async getSupportedFormats() {
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
  if (camera === "fake") return;
  const film = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 640;
    const context = canvas.getContext("2d")!;
    const modules = new Path2D(code.path);
    const draw = () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 640, 640);
      // A code in the middle third with a white quiet zone, as a phone held over a screen sees it.
      const scale = 320 / code.size;
      context.setTransform(scale, 0, 0, scale, 160, 160);
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
        if (camera === "code") return film();
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

async function open(options: { detector: Detector; camera: Camera; context?: BrowserContextOptions }): Promise<Page> {
  const context = await browser.newContext(options.context ?? phone);
  await context.addInitScript(stubDevice, { detector: options.detector, camera: options.camera, code });
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

  test("a detector error on one frame neither stops nor fails the camera", async () => {
    const page = await open({ detector: "transient", camera: "code" });
    try {
      await settled(page);
      expect(await calls(page)).toEqual({ results: [CODE], errors: [], stops: 0 });
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

  for (const [camera, reason, requests] of [
    ["NotAllowedError", "denied", 1],
    ["NotReadableError", "in-use", 1],
    ["NotFoundError", "no-camera", 6],
  ] as const) {
    test(`reports ${camera} from the camera as "${reason}"`, async () => {
      const page = await open({ detector: "none", camera });
      try {
        await settled(page);
        expect(await calls(page)).toEqual({ results: [], errors: [reason], stops: 0 });
        // Asking again could show the permission prompt again; only a missing camera is worth a looser request.
        expect((await probe(page)).requests.length).toBe(requests);
      } finally {
        await page.context().close();
      }
    }, 30_000);
  }
});
