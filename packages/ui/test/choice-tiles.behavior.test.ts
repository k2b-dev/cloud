import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("arrow keys select and focus the next tile in the current order, also after the options were reordered", async () => {
  const dom = createDomTestHarness();
  const { ChoiceTiles } = await import("../src/inputs/ChoiceTiles");
  const first = { value: "a", label: "A", visual: "a" };
  const second = { value: "b", label: "B", visual: "b" };
  const third = { value: "c", label: "C", visual: "c" };
  const [options, setOptions] = createSignal([first, second, third]);
  const [value, setValue] = createSignal<string | null>("a");
  const dispose = render(
    () =>
      createComponent(ChoiceTiles, {
        "aria-label": "Letters",
        get options() {
          return options();
        },
        value,
        onValueChange: setValue,
      }),
    dom.root,
  );
  setOptions([third, first, second]);
  await flush();
  const radios = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  expect(radios().map((radio) => radio.textContent)).toEqual(["cC", "aA", "bB"]);
  radios()[1]!.focus();
  radios()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await flush();
  expect(value()).toBe("b");
  expect(document.activeElement?.textContent).toBe("bB");
  radios()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  await flush();
  expect(value()).toBe("c");
  expect(document.activeElement?.textContent).toBe("cC");
  dispose();
  dom.cleanup();
});
