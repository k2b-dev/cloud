import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// This suite runs with browser conditions and the repository's Solid DOM preload.
describe("Slider default value and reset", () => {
  if (isServer) {
    test.skip("requires the dedicated browser-conditions process", () => {});
    return;
  }
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });
  const mount = async (
    initial: number,
    defaultValue?: number,
    formatValue?: (value: number) => string,
    valuePlacement?: "control" | "label",
  ) => {
    const dom = createDomTestHarness();
    delegateEvents(["click"], dom.document);
    const { Slider } = await import("../src/inputs/ChoiceInputs");
    const [value, setValue] = createSignal(initial);
    const changes: number[] = [];
    const commits: number[] = [];
    const dispose = render(
      () => (
        <Slider
          label="Brightness"
          value={value}
          min={0}
          max={2}
          step={0.01}
          defaultValue={defaultValue}
          formatValue={formatValue}
          valuePlacement={valuePlacement}
          onValueChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onValueCommit={(next) => commits.push(next)}
        />
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const slider = () => dom.root.querySelector<HTMLElement>(".k2b-slider")!;
    const reset = () => dom.root.querySelector<HTMLButtonElement>(".k2b-slider__reset");
    const input = () => dom.root.querySelector<HTMLInputElement>('input[type="range"]')!;
    return { dom, slider, reset, input, setValue, changes, commits };
  };

  test("keeps the reset slot at the default, but out of reach", async () => {
    const view = await mount(1, 1);
    expect(view.slider().getAttribute("data-changed")).toBeNull();
    expect(view.reset()).not.toBeNull();
    expect(view.reset()!.disabled).toBe(true);
  });

  test("marks a changed value and resets it to the default with focus on the slider", async () => {
    const view = await mount(1.4, 1);
    expect(view.slider().getAttribute("data-changed")).toBe("true");
    expect(view.reset()!.disabled).toBe(false);
    expect(view.reset()!.getAttribute("aria-describedby")).toBe(view.dom.root.querySelector("label")?.id ?? null);
    expect(view.reset()!.getAttribute("aria-label")).toBe("Reset to 1");
    view.reset()!.click();
    expect(view.changes).toEqual([1]);
    expect(view.commits).toEqual([1]);
    expect(view.slider().getAttribute("data-changed")).toBeNull();
    expect(view.dom.document.activeElement).toBe(view.input());
  });

  test("names the default in the reset label as the slider shows values", async () => {
    const view = await mount(1.4, 1, (value) => `${Math.round(value * 100)}%`);
    expect(view.reset()!.getAttribute("aria-label")).toBe("Reset to 100%");
  });

  test("has no reset and no changed state without a default value", async () => {
    const view = await mount(1.4);
    expect(view.reset()).toBeNull();
    expect(view.slider().getAttribute("data-changed")).toBeNull();
  });

  for (const placement of ["control", "label"] as const) {
    test(`${placement} placement keeps the value association and reset behavior`, async () => {
      const view = await mount(1.4, 1, undefined, placement);
      const output = view.dom.root.querySelector("output")!;
      expect(output.getAttribute("for")).toBe(view.input().id);
      expect(output.textContent).toBe("1.4");
      expect(view.input().hasAttribute("valuePlacement")).toBe(false);
      expect(view.reset()!.closest("label")).toBeNull();
      expect(output.closest(".k2b-field__label-row") !== null).toBe(placement === "label");
      expect(view.dom.root.querySelector("label")!.parentElement!.classList.contains("k2b-field")).toBe(placement === "control");
      expect(view.input().getAttribute("aria-labelledby")).toBe(view.dom.root.querySelector("label")!.id);
      view.reset()!.click();
      expect(view.changes).toEqual([1]);
      expect(view.commits).toEqual([1]);
      expect(output.textContent).toBe("1");
      expect(view.reset()!.disabled).toBe(true);
      expect(view.dom.document.activeElement).toBe(view.input());
    });
  }
});
