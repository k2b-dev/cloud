import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const format = { kind: "barcode", bcid: "code128" } as const;

const domTest = isServer ? test.skip : test;
domTest("a barcode keeps its server drawing until the on-demand drawing code has loaded", async () => {
  const dom = createDomTestHarness();
  try {
    // The server markup of one cell, as the island's wrapper holds it before mounting.
    const server = dom.document.createElement("span");
    server.dataset.gridsBarcode = "table:code128:0:ITEM-1";
    server.innerHTML = '<svg data-from-server="true" viewBox="0 0 10 10"></svg>';
    dom.document.body.append(server);
    const { barcodesReady } = await import("#barcode-drawing");
    const { BarcodeDisplay } = await import("./BarcodeCell");
    server.remove();
    expect(barcodesReady()).toBe(false);

    const dispose = render(
      () => [createComponent(BarcodeDisplay, { value: "ITEM-1", format }), createComponent(BarcodeDisplay, { value: "ITEM-2", format })],
      dom.root,
    );
    const [drawn, waiting] = [...dom.root.querySelectorAll<HTMLElement>(".grids-code-display")];
    // The first browser render shows the server's drawing; a value without one keeps the drawing's place.
    expect(drawn!.dataset.gridsBarcode).toBe("table:code128:0:ITEM-1");
    expect(drawn!.querySelector("svg")?.dataset.fromServer).toBe("true");
    expect(waiting!.getAttribute("aria-busy")).toBe("true");
    expect(waiting!.style.height).toBe("2.25rem");
    expect(waiting!.textContent).toBe("ITEM-2");

    // The waiting cell started the load; both cells then draw with the loaded code.
    for (let attempt = 0; attempt < 200 && !barcodesReady(); attempt++) await Bun.sleep(10);
    expect(barcodesReady()).toBe(true);
    const cells = [...dom.root.querySelectorAll<HTMLElement>(".grids-code-display")];
    expect(cells.map((cell) => cell.dataset.gridsBarcode)).toEqual(["table:code128:0:ITEM-1", "table:code128:0:ITEM-2"]);
    for (const cell of cells) {
      expect(cell.querySelector("svg path")).not.toBeNull();
      expect(cell.querySelector("[data-from-server]")).toBeNull();
    }
    dispose();
  } finally {
    dom.cleanup();
  }
});
