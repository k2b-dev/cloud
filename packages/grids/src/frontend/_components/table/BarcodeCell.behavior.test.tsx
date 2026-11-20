import { expect, test } from "bun:test";
import { createComponent, createEffect, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const format = { kind: "barcode", bcid: "ean13" } as const;

const domTest = isServer ? test.skip : test;
domTest("a barcode shows what the server showed until the on-demand drawing code has loaded", async () => {
  const dom = createDomTestHarness();
  try {
    // Server markup as the island's wrapper holds it before mounting: one drawing, and one value the server could not
    // draw and showed as text. The keys are the ones the server writes (FieldValue.render.test.ts pins that markup).
    const server = dom.document.createElement("div");
    server.innerHTML = [
      '<span data-grids-barcode="table:ean13:0:5901234123457"><span class="grids-code-display"><svg data-from-server="true"></svg></span></span>',
      '<span data-grids-barcode="table:ean13:0:abc"><span class="font-mono">abc</span></span>',
    ].join("");
    dom.document.body.append(server);
    const { barcodesReady } = await import("#barcode-drawing");
    const { BarcodeDisplay } = await import("./BarcodeCell");
    server.remove();
    expect(barcodesReady()).toBe(false);

    const ready = new Promise<void>((resolve) =>
      createRoot(() =>
        createEffect(() => {
          if (barcodesReady()) resolve();
        }),
      ),
    );
    const dispose = render(
      () =>
        ["5901234123457", "abc", "4006381333931"].map((value) => createComponent(BarcodeDisplay, { value, format, showOpenAction: true })),
      dom.root,
    );
    const cells = () => [...dom.root.querySelectorAll<HTMLElement>("[data-grids-barcode]")];
    const [drawn, text, waiting] = cells();
    // The first browser render shows what the server showed; only a value the server never rendered waits in its place.
    expect(drawn!.querySelector("svg")?.dataset.fromServer).toBe("true");
    expect(text!.querySelector("svg")).toBeNull();
    expect(text!.querySelector(".font-mono")?.textContent).toBe("abc");
    expect(text!.querySelector("[aria-busy]")).toBeNull();
    const placeholder = waiting!.querySelector<HTMLElement>("[aria-busy='true']");
    expect(placeholder?.style.height).toBe("2.25rem");
    expect(placeholder?.textContent).toBe("4006381333931");

    // The waiting cell started the load; the drawable values then draw with the loaded code.
    await ready;
    const [drawnAfter, textAfter, waitingAfter] = cells();
    expect(drawnAfter!.querySelector("svg path")).not.toBeNull();
    expect(drawnAfter!.querySelector("[data-from-server]")).toBeNull();
    expect(textAfter!.querySelector(".font-mono")?.textContent).toBe("abc");
    expect(waitingAfter!.querySelector("svg path")).not.toBeNull();
    expect(waitingAfter!.querySelector("[aria-busy]")).toBeNull();
    dispose();
  } finally {
    dom.cleanup();
  }
});
