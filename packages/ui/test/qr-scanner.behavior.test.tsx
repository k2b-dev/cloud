import { afterEach, describe, expect, mock, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/** Stands in for the qr-scanner engine: tests decode text and report frame errors on demand. */
class FakeEngine {
  static readonly NO_QR_CODE_FOUND = "No QR code found";
  static _disableBarcodeDetector = false;
  static last: FakeEngine | undefined;
  static start: () => Promise<void> = async () => {};
  readonly options: { onDecodeError?: (error: Error | string) => void };
  paused: boolean[] = [];
  destroyed = false;
  constructor(
    readonly video: HTMLVideoElement,
    readonly onDecode: (result: { data: string }) => void,
    options: FakeEngine["options"],
  ) {
    this.options = options;
    FakeEngine.last = this;
  }
  start() {
    return FakeEngine.start();
  }
  async pause(stopStreamImmediately = false) {
    this.paused.push(stopStreamImmediately);
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
}
mock.module("qr-scanner", () => ({ default: FakeEngine }));

/** A camera stream whose track reports the facing a phone gives and whether it was stopped. */
const cameraStream = (facingMode?: string) => {
  const track = {
    stopped: false,
    stop() {
      track.stopped = true;
    },
    getSettings: () => ({ facingMode }),
  };
  return Object.assign(new dom.window.MediaStream(), { track, getTracks: () => [track], getVideoTracks: () => [track] });
};

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  FakeEngine.last = undefined;
  FakeEngine.start = async () => {};
  FakeEngine._disableBarcodeDetector = false;
  dom.cleanup();
});

const settle = () => Bun.sleep(10);

type Camera = (video: MediaTrackConstraints) => Promise<unknown>;

async function mount(options: { accept?: (text: string) => boolean; camera?: Camera | null } = {}) {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
  const requests: MediaTrackConstraints[] = [];
  const camera = options.camera === undefined ? async () => cameraStream("environment") : options.camera;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: camera && {
      getUserMedia: ({ video }: { video: MediaTrackConstraints }) => {
        requests.push(video);
        return camera(video);
      },
    },
  });
  const { QrScanner } = await import("../src/inputs/QrScanner");
  const calls = { results: [] as string[], stops: 0, errors: [] as string[], requests };
  dispose = render(
    () => (
      <QrScanner
        instructions="Point the camera at the pairing code."
        onResult={(text) => {
          calls.results.push(text);
          return options.accept?.(text) ?? false;
        }}
        onStop={() => calls.stops++}
        onError={(reason) => calls.errors.push(reason)}
      />
    ),
    dom.root,
  );
  await settle();
  return calls;
}

const refuse =
  (name: string): Camera =>
  async () => {
    throw new DOMException("The camera refused.", name);
  };
const status = () => document.querySelector('[role="status"]')?.textContent;
const preview = () => document.querySelector<HTMLElement>(".k2b-qr-scanner__preview")!;
const video = () => document.querySelector("video")!;

describe("QrScanner", () => {
  test("starts the rear camera, then shows the instructions and the privacy note", async () => {
    const calls = await mount();
    expect(calls.requests).toEqual([{ width: { min: 1024 }, facingMode: { exact: "environment" } }]);
    expect(FakeEngine.last?.video).toBe(video());
    expect(video().srcObject).not.toBeNull();
    expect(video().style.transform).toBe("");
    expect(status()).toBe("Point the camera at the pairing code.");
    expect(document.querySelector(".k2b-qr-scanner__note")?.textContent).toBe("Camera images stay on this device.");
  });

  test("tries looser requests only while no camera fits, and mirrors a camera that is not the rear one", async () => {
    const calls = await mount({
      camera: async (request) => (request.facingMode ? refuse("OverconstrainedError")(request) : cameraStream()),
    });
    expect(calls.requests).toHaveLength(4);
    expect(calls.requests.at(-1)).toEqual({ width: { min: 1024 } });
    expect(calls.errors).toEqual([]);
    expect(video().style.transform).toBe("scaleX(-1)");
  });
  test("an accepted result stops the camera at once", async () => {
    const calls = await mount({ accept: () => true });
    const engine = FakeEngine.last!;
    engine.onDecode({ data: "https://cloud.example/pair#code" });
    expect(calls.results).toEqual(["https://cloud.example/pair#code"]);
    expect(engine.paused).toEqual([true]);
    expect(engine.destroyed).toBe(true);
    engine.onDecode({ data: "late frame" });
    expect(calls.results).toHaveLength(1);
  });

  test("a rejected code marks the frame and is not reported again for every frame", async () => {
    const calls = await mount();
    const engine = FakeEngine.last!;
    engine.onDecode({ data: "not a pairing link" });
    engine.onDecode({ data: "not a pairing link" });
    expect(calls.results).toEqual(["not a pairing link"]);
    expect(preview().hasAttribute("data-invalid")).toBe(true);
    expect(engine.destroyed).toBe(false);
    engine.onDecode({ data: "another code" });
    expect(calls.results).toEqual(["not a pairing link", "another code"]);
  });

  test("asks the host to stop when the page is hidden or left", async () => {
    const calls = await mount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    expect(calls.stops).toBe(2);
  });

  for (const [name, reason, requests] of [
    ["NotAllowedError", "denied", 1],
    ["SecurityError", "denied", 1],
    ["NotReadableError", "in-use", 1],
    ["AbortError", "unavailable", 1],
    ["NotFoundError", "no-camera", 6],
    ["OverconstrainedError", "no-camera", 6],
  ] as const) {
    test(`reports ${name} from the camera as ${reason}`, async () => {
      const calls = await mount({ camera: refuse(name) });
      expect(calls.errors).toEqual([reason]);
      expect(calls.requests).toHaveLength(requests);
      expect(FakeEngine.last?.destroyed).toBe(true);
    });
  }

  test("reports a browser without camera access as unavailable", async () => {
    const calls = await mount({ camera: null });
    expect(calls.errors).toEqual(["unavailable"]);
  });

  test("reports a camera that opens but does not play as unavailable", async () => {
    FakeEngine.start = async () => {
      throw new DOMException("The play() request was interrupted.", "AbortError");
    };
    const calls = await mount();
    expect(calls.errors).toEqual(["unavailable"]);
    expect(FakeEngine.last?.destroyed).toBe(true);
  });

  test("does not report a failure that settles after the host unmounted the scanner", async () => {
    let refuseNow!: () => void;
    const calls = await mount({
      camera: () => new Promise((_, reject) => (refuseNow = () => reject(new DOMException("Denied.", "NotAllowedError")))),
    });
    dispose?.();
    dispose = undefined;
    refuseNow();
    await settle();
    expect(calls.errors).toEqual([]);
  });

  test("a frame that cannot be decoded never stops the camera; a failing BarcodeDetector hands over to the worker", async () => {
    const calls = await mount();
    const engine = FakeEngine.last!;
    // Empty frames: the worker reports the bare constant, Chrome for Android's BarcodeDetector the prefixed one.
    engine.options.onDecodeError?.(FakeEngine.NO_QR_CODE_FOUND);
    engine.options.onDecodeError?.(`Scanner error: ${FakeEngine.NO_QR_CODE_FOUND}`);
    expect(FakeEngine._disableBarcodeDetector).toBe(false);
    engine.options.onDecodeError?.(new Error("canvas lost"));
    expect(FakeEngine._disableBarcodeDetector).toBe(false);
    engine.options.onDecodeError?.("Scanner error: Unsupported source.");
    expect(FakeEngine._disableBarcodeDetector).toBe(true);
    await settle();
    expect(calls.errors).toEqual([]);
    expect(engine.destroyed).toBe(false);
    expect(engine.paused).toEqual([]);
  });

  test("unmounting releases the camera, even during a pending permission prompt", async () => {
    let grant!: (stream: ReturnType<typeof cameraStream>) => void;
    const calls = await mount({
      camera: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    });
    const engine = FakeEngine.last!;
    expect(status()).toBe("Starting camera…");
    dispose?.();
    dispose = undefined;
    expect(engine.paused).toEqual([true]);
    expect(engine.destroyed).toBe(true);
    // The stream the browser hands over after the prompt stops at once and never reaches the preview.
    const stream = cameraStream("environment");
    grant(stream);
    await settle();
    expect(stream.track.stopped).toBe(true);
    expect(calls.errors).toEqual([]);
  });
});
