import { afterEach, describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const markup =
  '<svg xmlns="http://www.w3.org/2000/svg" id="m1" width="100%" viewBox="0 0 120.4 60" style="max-width: 120.4px;" role="graphics-document"><rect width="120" height="60"/></svg>';

const globals = globalThis as unknown as Record<string, unknown>;
let dom: DomTestHarness | undefined;
const setup = () => {
  dom = createDomTestHarness();
  globals.DOMParser = dom.window.DOMParser;
  globals.XMLSerializer = dom.window.XMLSerializer;
  return dom;
};
afterEach(() => {
  delete globals.DOMParser;
  delete globals.XMLSerializer;
  delete globals.Image;
  dom?.cleanup();
  dom = undefined;
});

describe("Mermaid export", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("a standalone SVG takes its size from the viewBox instead of the page", async () => {
    setup();
    const { standaloneSvg } = await import("./mermaid-export");
    const result = standaloneSvg(markup);
    expect(result.width).toBe(121);
    expect(result.height).toBe(60);
    expect(result.svg).toContain('width="121"');
    expect(result.svg).toContain('height="60"');
    expect(result.svg).not.toContain("max-width");
    expect(result.svg).toContain("<rect");
    expect(() => standaloneSvg("<div/>")).toThrow();
    expect(() => standaloneSvg('<svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow();
  });

  test("PNG rasterizes through an image at the requested scale on the theme background", async () => {
    const harness = setup();
    const { diagramBackground, rasterizeSvg, standaloneSvg } = await import("./mermaid-export");
    const loaded: string[] = [];
    // happy-dom decodes no images and has no 2D canvas; record what the export asks for.
    globals.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        loaded.push(value);
        queueMicrotask(() => this.onload?.());
      }
    };
    const calls: string[] = [];
    const createElement = harness.document.createElement.bind(harness.document);
    harness.document.createElement = ((name: string) => {
      const element = createElement(name);
      if (name !== "canvas") return element;
      Object.assign(element, {
        getContext: () => ({
          set fillStyle(value: string) {
            calls.push(`fill ${value}`);
          },
          fillRect: (x: number, y: number, width: number, height: number) => calls.push(`rect ${x} ${y} ${width} ${height}`),
          drawImage: (_image: unknown, x: number, y: number, width: number, height: number) =>
            calls.push(`draw ${x} ${y} ${width} ${height}`),
        }),
        toBlob: (done: (blob: Blob | null) => void, type: string) => done(new Blob(["png"], { type })),
      });
      return element;
    }) as typeof harness.document.createElement;

    const blob = await rasterizeSvg(standaloneSvg(markup), { background: diagramBackground(true), scale: 2 });
    expect(blob.type).toBe("image/png");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toStartWith("blob:");
    expect(calls).toEqual(["fill #11151b", "rect 0 0 242 120", "draw 0 0 242 120"]);
    expect(diagramBackground(false)).toBe("#ffffff");
  });

  test("PNG scale follows the device but stays under the smallest canvas limit", async () => {
    setup();
    const { pngScale } = await import("./mermaid-export");
    expect(pngScale(800, 600, 1)).toBe(2);
    expect(pngScale(800, 600, 3)).toBe(3);
    const huge = pngScale(6000, 4000, 2);
    expect(6000 * huge * 4000 * huge).toBeLessThanOrEqual(16_777_216 + 1);
  });

  test("file names come from the note title or fall back to diagram", async () => {
    setup();
    const { diagramFilename } = await import("./mermaid-export");
    expect(diagramFilename("Q3: plan / review")).toBe("Q3- plan - review");
    expect(diagramFilename("  ")).toBe("diagram");
    expect(diagramFilename(null)).toBe("diagram");
  });
});
