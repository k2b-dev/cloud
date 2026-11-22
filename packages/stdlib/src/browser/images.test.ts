import { describe, it, expect, beforeAll, afterAll } from "bun:test";

// images.ts requires document, HTMLCanvasElement, HTMLImageElement, etc.
// In bun's test runner without happy-dom these globals are undefined, so we
// stub the minimum surface needed to test the input-validation and
// race-handling paths. Pixel-perfect canvas behaviour is intentionally
// out-of-scope for unit tests — verify visually in a real browser.

class FakeCanvas {
  width = 0;
  height = 0;
  getContext(type: string) {
    if (type !== "2d") return null;
    return {
      // Just enough surface for the transforms we exercise via validation.
      drawImage: () => {},
      fillRect: () => {},
      fillStyle: "",
      filter: "",
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => {},
    };
  }
  toBlob(cb: (b: Blob | null) => void, _type?: string) {
    cb(new Blob([new Uint8Array([0])], { type: "image/png" }));
  }
}

class FakeImage {
  src = "";
  crossOrigin: string | null = null;
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(ev: string, fn: () => void, _opts?: AddEventListenerOptions) {
    if (ev === "load") this.onload = fn;
    if (ev === "error") this.onerror = fn;
  }
}

// Always override globals — other test files in the same process leak partial
// document/window stubs that don't provide canvas creation.
const FAKE_DOC = {
  createElement(tag: string) {
    if (tag === "canvas") return new FakeCanvas();
    throw new Error(`fake document only supports canvas (got ${tag})`);
  },
};
const savedGlobals: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ["document", "HTMLCanvasElement", "HTMLImageElement", "Image"]) {
    savedGlobals[k] = (globalThis as any)[k];
  }
  (globalThis as any).document = FAKE_DOC;
  (globalThis as any).HTMLCanvasElement = FakeCanvas;
  (globalThis as any).HTMLImageElement = FakeImage;
  (globalThis as any).Image = FakeImage;
});
afterAll(() => {
  for (const k of ["document", "HTMLCanvasElement", "HTMLImageElement", "Image"]) {
    (globalThis as any)[k] = savedGlobals[k];
  }
});

// Also set up globals BEFORE the import so module-evaluation has them ready.
(globalThis as any).document = FAKE_DOC;
(globalThis as any).HTMLCanvasElement = FakeCanvas;
(globalThis as any).HTMLImageElement = FakeImage;
(globalThis as any).Image = FakeImage;

import { images } from "./images";

describe("images.create", () => {
  it("attaches load handlers BEFORE setting src (no race for cached/data URLs)", async () => {
    // Image whose src setter fires onload synchronously via microtask. The
    // race we're guarding against: if production code assigns src BEFORE
    // attaching onload, the onload never fires and create() hangs forever.
    function SyncImage(this: any) {
      this.crossOrigin = null;
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.onload = null;
      this.onerror = null;
      this.addEventListener = function (ev: string, fn: () => void) {
        if (ev === "load") this.onload = fn;
        if (ev === "error") this.onerror = fn;
      };
      let _src = "";
      Object.defineProperty(this, "src", {
        get() { return _src; },
        set(v: string) {
          _src = v;
          this.naturalWidth = 10;
          this.naturalHeight = 10;
          this.complete = true;
          queueMicrotask(() => this.onload?.());
        },
      });
    }
    (globalThis as any).Image = SyncImage;
    const result = await images.create("https://example.com/x.png");
    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    (globalThis as any).Image = FakeImage;
  });
});

describe("images.resize — validation", () => {
  it("throws on width 0", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 50 };
    Object.assign(d.canvas, { width: 100, height: 50 });
    await expect(images.resize(0, 50)(d as any)).rejects.toThrow(RangeError);
  });

  it("throws on negative height", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 50 };
    Object.assign(d.canvas, { width: 100, height: 50 });
    await expect(images.resize(50, -10)(d as any)).rejects.toThrow(RangeError);
  });

  it("throws on NaN dimension", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 50 };
    Object.assign(d.canvas, { width: 100, height: 50 });
    await expect(images.resize(NaN, 50)(d as any)).rejects.toThrow(RangeError);
  });

  it("returns input unchanged when both width and height are undefined", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 50 };
    const out = await images.resize()(d as any);
    expect(out.width).toBe(100);
    expect(out.height).toBe(50);
  });
});

describe("images.crop — validation", () => {
  it("throws on zero w", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 100 };
    await expect(images.crop(0, 0, 0, 50)(d as any)).rejects.toThrow(RangeError);
  });

  it("throws on negative h", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 100 };
    await expect(images.crop(0, 0, 50, -10)(d as any)).rejects.toThrow(RangeError);
  });

  it("throws on Infinity", async () => {
    const d = { canvas: new FakeCanvas(), ctx: {} as any, width: 100, height: 100 };
    await expect(images.crop(0, 0, Infinity, 10)(d as any)).rejects.toThrow(RangeError);
  });
});

describe("images namespace", () => {
  it("exposes documented surface", () => {
    expect(typeof images.create).toBe("function");
    expect(typeof images.resize).toBe("function");
    expect(typeof images.crop).toBe("function");
    expect(typeof images.rotate).toBe("function");
    expect(typeof images.flip).toBe("function");
    expect(typeof images.filter).toBe("function");
    expect(typeof images.toBlob).toBe("function");
    expect(typeof images.batch).toBe("function");
  });
});
