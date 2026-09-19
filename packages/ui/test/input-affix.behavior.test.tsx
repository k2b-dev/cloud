import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const css = await Bun.file(new URL("../src/styles/index.css", import.meta.url)).text();
const affixRules = [...css.matchAll(/[^{}]*\.k2b-input-shell__(?:affix|clear)[^{}]*\{[^{}]*\}/g)]
  .map((match) => match[0].replace(/@apply[^;]*;/g, ""))
  .join("\n");

for (const variant of ["text", "number", "number-with-steppers"] as const) {
  for (const clearable of [false, true]) {
    test(`${variant} reserves suffix edge spacing with clearable=${clearable}`, async () => {
      const dom = createDomTestHarness();
      const { TextInput } = await import("../src/inputs/TextInput");
      const { NumberInput } = await import("../src/inputs/NumberInput");
      const style = dom.document.createElement("style");
      style.textContent = affixRules;
      dom.document.head.append(style);
      dom.root.className = "k2b-ui";
      const dispose = render(
        () =>
          variant === "text" ? (
            <TextInput label="Amount" value="42" icon="ti ti-number" prefix="From" suffix={<span>EUR</span>} clearable={clearable} />
          ) : (
            <NumberInput
              label="Amount"
              value={42}
              icon="ti ti-number"
              prefix="From"
              suffix={<span>EUR</span>}
              showSteppers={variant === "number-with-steppers"}
              clearable={clearable}
            />
          ),
        dom.root,
      );
      try {
        const suffix = dom.root.querySelectorAll<HTMLElement>(".k2b-input-shell__affix")[1]!;
        const clear = dom.root.querySelector<HTMLButtonElement>(".k2b-input-shell__clear");
        expect(suffix.textContent).toBe("EUR");
        expect(Boolean(clear)).toBe(clearable);
        expect(suffix.matches(":last-child")).toBe(!clearable);
        if (clear) {
          expect(getComputedStyle(clear).marginRight).toBe("3px");
          expect(getComputedStyle(suffix).marginRight).not.toBe("10px");
        } else {
          expect(getComputedStyle(suffix).marginRight).toBe("10px");
        }
      } finally {
        dispose();
        dom.cleanup();
      }
    });
  }
}
