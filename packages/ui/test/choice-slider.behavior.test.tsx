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
  const mount = async (initial: string | null, list: ChoiceSliderOption[] = options, extra: { disabled?: () => boolean } = {}) => {
    const dom = createDomTestHarness();
    delegateEvents(["keydown", "pointerdown", "pointermove", "pointerup"], dom.document);
    const { ChoiceSlider } = await import("../src/inputs/ChoiceSlider");
    const [value, setValue] = createSignal<string | null>(initial);
    const [currentOptions, setOptions] = createSignal(list);
    const changes: string[] = [];
    const dispose = render(
      () => (
        <ChoiceSlider
          aria-label="Model class"
          options={currentOptions()}
          disabled={extra.disabled?.()}
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
    const pointer = (type: string, pointerId = 1) =>
      slider()!.dispatchEvent(
        new dom.window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId, button: 0, clientX: 0 }) as unknown as Event,
      );
    return { slider, line, changes, value, setOptions, pointer };
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

  test("a release chooses the pressed stop; a lost capture or a cancel does not", async () => {
    const view = await mount("balanced");
    view.pointer("pointerdown");
    view.pointer("lostpointercapture");
    expect(view.changes).toEqual([]);
    view.pointer("pointerdown");
    view.pointer("pointercancel");
    expect(view.changes).toEqual([]);
    view.pointer("pointerdown");
    view.pointer("pointerup");
    expect(view.changes).toEqual(["fast"]);
  });

  test("a second pointer neither takes over nor ends the drag", async () => {
    const view = await mount("balanced");
    view.pointer("pointerdown", 1);
    view.pointer("pointerdown", 2);
    view.pointer("pointerup", 2);
    expect(view.changes).toEqual([]);
    view.pointer("pointerup", 1);
    expect(view.changes).toEqual(["fast"]);
  });

  test("a drag whose stop disappears or becomes unavailable ends without a choice", async () => {
    const view = await mount("balanced");
    view.pointer("pointerdown");
    view.setOptions(options.slice(1));
    expect(view.slider()?.getAttribute("aria-valuenow")).toBe("1");
    view.pointer("pointerup");
    view.setOptions(options);
    view.pointer("pointerdown");
    view.setOptions(options.map((option) => (option.value === "fast" ? { ...option, disabledReason: "Gone" } : option)));
    view.pointer("pointerup");
    expect(view.changes).toEqual([]);
  });

  test("a drag on a slider that becomes disabled chooses nothing", async () => {
    const [disabled, setDisabled] = createSignal(false);
    const view = await mount("balanced", options, { disabled });
    view.pointer("pointerdown");
    setDisabled(true);
    view.pointer("pointerup");
    expect(view.changes).toEqual([]);
  });

  test("draws one rail with a fill that ends at the thumb", async () => {
    const view = await mount("balanced");
    const track = view.slider()!;
    const fill = track.querySelector<HTMLElement>(".k2b-choice-slider__fill");
    expect(track.querySelectorAll(".k2b-choice-slider__rail")).toHaveLength(1);
    expect(track.querySelector(".k2b-choice-slider__segment")).toBeNull();
    expect(fill?.hidden).toBe(false);
    // Fill and thumb read the same position, so the fill always ends at the thumb's centre.
    expect(track.style.getPropertyValue("--k2b-choice-slider-at")).toBe(`${(1 / 3) * 100}%`);
    key(track, "End");
    expect(track.style.getPropertyValue("--k2b-choice-slider-at")).toBe("100%");
    const stops = [...track.querySelectorAll(".k2b-choice-slider__stop")];
    expect(stops.map((stop) => [stop.hasAttribute("data-on"), stop.hasAttribute("data-current")])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [false, true],
    ]);
  });

  test("marks the track while a drag previews a stop, and only then", async () => {
    const view = await mount("balanced");
    expect(view.slider()?.hasAttribute("data-dragging")).toBe(false);
    view.pointer("pointerdown");
    expect(view.slider()?.hasAttribute("data-dragging")).toBe(true);
    view.pointer("pointerup");
    expect(view.slider()?.hasAttribute("data-dragging")).toBe(false);
    view.pointer("pointerdown");
    view.pointer("pointercancel");
    expect(view.slider()?.hasAttribute("data-dragging")).toBe(false);
  });

  test("a choice outside the stops hides the fill with the thumb", async () => {
    const view = await mount(null);
    expect(view.slider()?.querySelector<HTMLElement>(".k2b-choice-slider__fill")?.hidden).toBe(true);
    expect(view.slider()?.querySelectorAll("[data-on]")).toHaveLength(0);
  });

  test("one stop renders the line without a track", async () => {
    const view = await mount("fast", options.slice(0, 1));
    expect(view.slider()).toBeNull();
    expect(view.line()).toBe("When speed matters");
  });
});
