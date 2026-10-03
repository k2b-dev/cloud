import { afterEach, describe, expect, mock, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/** Stands in for the qr-scanner engine: tests decode text and fail the camera on demand. */
class FakeEngine {
  static readonly NO_QR_CODE_FOUND = "No QR code found";
  static last: FakeEngine | undefined;
  static start: () => Promise<void> = async () => {};
  readonly options: { preferredCamera?: string; onDecodeError?: (error: Error | string) => void };
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

let dom: DomTestHarness;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  FakeEngine.last = undefined;
  FakeEngine.start = async () => {};
  dom.cleanup();
});

const settle = () => Bun.sleep(10);

async function mount(options: { accept?: (text: string) => boolean; permission?: PermissionState | Promise<PermissionState> } = {}) {
  dom = createDomTestHarness();
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: dom.window.matchMedia.bind(dom.window) });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: async () => ({ state: await (options.permission ?? "prompt") }) },
  });
  const { QrScanner } = await import("../src/inputs/QrScanner");
  const calls = { results: [] as string[], stops: 0, errors: [] as string[] };
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

const status = () => document.querySelector('[role="status"]')?.textContent;
const preview = () => document.querySelector<HTMLElement>(".k2b-qr-scanner__preview")!;

describe("QrScanner", () => {
  test("starts the rear camera, then shows the instructions and the privacy note", async () => {
    await mount();
    expect(FakeEngine.last?.options.preferredCamera).toBe("environment");
    expect(FakeEngine.last?.video).toBe(document.querySelector("video")!);
    expect(status()).toBe("Point the camera at the pairing code.");
    expect(document.querySelector(".k2b-qr-scanner__note")?.textContent).toBe("Camera images stay on this device.");
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

  test("reports denied camera access", async () => {
    FakeEngine.start = async () => {
      throw "Camera not found.";
    };
    const calls = await mount({ permission: "denied" });
    expect(calls.errors).toEqual(["denied"]);
    expect(FakeEngine.last?.destroyed).toBe(true);
  });

  test("reports a missing camera as unavailable", async () => {
    FakeEngine.start = async () => {
      throw "Camera not found.";
    };
    const calls = await mount();
    expect(calls.errors).toEqual(["unavailable"]);
  });

  test("does not report a failure that settles after the host unmounted the scanner", async () => {
    FakeEngine.start = async () => {
      throw "Camera not found.";
    };
    let answer!: (state: PermissionState) => void;
    const calls = await mount({ permission: new Promise<PermissionState>((resolve) => (answer = resolve)) });
    expect(FakeEngine.last?.destroyed).toBe(true);
    dispose?.();
    dispose = undefined;
    answer("denied");
    await settle();
    expect(calls.errors).toEqual([]);
  });

  test("ignores empty frames but fails on an engine error", async () => {
    const calls = await mount();
    FakeEngine.last!.options.onDecodeError?.(FakeEngine.NO_QR_CODE_FOUND);
    expect(calls.errors).toEqual([]);
    FakeEngine.last!.options.onDecodeError?.(new Error("worker crashed"));
    await settle();
    expect(calls.errors).toEqual(["unavailable"]);
  });

  test("unmounting releases the camera, even during a pending permission prompt", async () => {
    let release!: () => void;
    FakeEngine.start = () => new Promise<void>((resolve) => (release = resolve));
    await mount();
    const engine = FakeEngine.last!;
    expect(status()).toBe("Starting camera…");
    dispose?.();
    dispose = undefined;
    expect(engine.paused).toEqual([true]);
    expect(engine.destroyed).toBe(true);
    release();
  });
});
