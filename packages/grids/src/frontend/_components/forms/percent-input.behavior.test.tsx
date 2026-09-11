import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
for (const [range, initial, edited] of [
  ["percent", 25.125, "26.375"],
  ["fraction", 0.25125, "0.26375"],
] as const) {
  domTest(`percent input preserves configured ${range} scale and precision`, async () => {
    const dom = createDomTestHarness();
    const { FieldInput } = await import("./form-fields");
    const [value, setValue] = createSignal<unknown>(initial);
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const dispose = render(
      () =>
        createComponent(FieldInput, {
          field: { id: "Rate01", name: "Rate", type: "percent", required: false, config: { range, decimals: 5 } },
          entry: { kind: "user_input", fieldId: "Rate01" },
          get value() {
            return value();
          },
          onChange: setValue,
        }),
      host,
    );
    try {
      const input = host.querySelector<HTMLInputElement>("input")!;
      expect(input.value).toBe(String(initial));
      input.value = edited;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur"));
      expect(value()).toBe(Number(edited));
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
