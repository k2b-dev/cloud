import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { ChoiceSliderOption } from "../src/inputs/ChoiceSlider";
import { createDomTestHarness } from "./dom";

const options: ChoiceSliderOption[] = [
  { value: "fast", label: "Fast", description: "When speed matters" },
  { value: "balanced", label: "Balanced", description: "For most tasks" },
  { value: "thorough", label: "Thorough", disabledReason: "Budget used up until Monday" },
  { value: "maximum", label: "Maximum", description: "For the hardest questions" },
];
const key = (element: Element, value: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));

// This suite runs with browser conditions and the repository's Solid DOM preload.
describe("ChoiceSlider behavior", () => {
  if (isServer) {
    test.skip("requires the dedicated browser-conditions process", () => {});
    return;
  }
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });
  const mount = async (initial: string | null, list: ChoiceSliderOption[] = options) => {
    const dom = createDomTestHarness();
    delegateEvents(["keydown", "pointerdown", "pointermove", "pointerup"], dom.document);
    const { ChoiceSlider } = await import("../src/inputs/ChoiceSlider");
    const [value, setValue] = createSignal<string | null>(initial);
    const changes: string[] = [];
    const dispose = render(
      () => (
        <ChoiceSlider
          aria-label="Model class"
          options={list}
          value={value}
          description="Own choice"
          onValueChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
        />
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const slider = () => dom.root.querySelector<HTMLElement>('[role="slider"]');
    const line = () => dom.root.querySelector(".k2b-choice-slider__line")?.textContent;
    return { slider, line, changes, value };
  };

  test("names the stop and keeps its description in the line", async () => {
    const view = await mount("balanced");
    expect(view.slider()?.getAttribute("aria-valuenow")).toBe("2");
    expect(view.slider()?.getAttribute("aria-valuetext")).toBe("Balanced, For most tasks");
    expect(view.line()).toBe("For most tasks");
  });

  test("arrow keys skip an unavailable stop and Home and End reach the ends", async () => {
    const view = await mount("balanced");
    key(view.slider()!, "ArrowRight");
    expect(view.value()).toBe("maximum");
    key(view.slider()!, "Home");
    expect(view.value()).toBe("fast");
    key(view.slider()!, "End");
    expect(view.value()).toBe("maximum");
    expect(view.changes).toEqual(["maximum", "fast", "maximum"]);
  });

  test("an unavailable stop at the edge explains itself in the line", async () => {
    const view = await mount("balanced", options.slice(0, 3));
    key(view.slider()!, "ArrowRight");
    expect(view.value()).toBe("balanced");
    expect(view.line()).toBe("Budget used up until Monday");
    expect(view.changes).toEqual([]);
  });

  test("a chosen stop that became unavailable shows its reason", async () => {
    const view = await mount("thorough");
    expect(view.line()).toBe("Budget used up until Monday");
    expect(view.slider()?.querySelector(".k2b-choice-slider__thumb")?.getAttribute("data-tone")).toBe("warning");
  });

  test("a choice outside the stops shows no thumb and the fallback line", async () => {
    const view = await mount(null);
    expect(view.slider()?.querySelector<HTMLElement>(".k2b-choice-slider__thumb")?.hidden).toBe(true);
    expect(view.line()).toBe("Own choice");
    key(view.slider()!, "ArrowRight");
    expect(view.value()).toBe("fast");
  });

  test("one stop renders the line without a track", async () => {
    const view = await mount("fast", options.slice(0, 1));
    expect(view.slider()).toBeNull();
    expect(view.line()).toBe("When speed matters");
  });
});
