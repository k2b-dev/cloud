import { afterEach, expect, mock, test } from "bun:test";
import { attachResizeSeparator } from "../src/layout/resize-separator";
import { createDomTestHarness } from "./dom";

let cleanup = () => {};
afterEach(() => cleanup());
function setup(
  options: { orientation?: "vertical" | "horizontal"; grow?: "start" | "end"; rtl?: boolean; commit?: boolean; onReset?: () => void } = {},
) {
  const dom = createDomTestHarness();
  const handle = document.createElement("div");
  handle.tabIndex = 0;
  handle.setAttribute("aria-orientation", options.orientation ?? "vertical");
  handle.style.direction = options.rtl ? "rtl" : "ltr";
  dom.root.append(handle);
  let captured: number | undefined;
  Object.defineProperties(handle, {
    setPointerCapture: {
      value: (id: number) => {
        captured = id;
      },
    },
    hasPointerCapture: { value: (id: number) => captured === id },
    releasePointerCapture: {
      value: () => {
        captured = undefined;
      },
    },
  });
  let value = 24;
  const commits: number[] = [];
  const intents: boolean[] = [];
  const dragging: boolean[] = [];
  let collapses = 0;
  const dispose = attachResizeSeparator(handle, {
    min: 20,
    max: 36,
    value: () => value,
    unit: 16,
    step: 1,
    largeStep: 4,
    grow: options.grow ?? "start",
    collapseBelow: 16,
    onResize: (next) => {
      value = next;
    },
    ...(options.commit === false ? {} : { onResizeEnd: (next: number) => commits.push(next) }),
    onCollapseIntent: (armed) => intents.push(armed),
    onCollapse: () => {
      collapses++;
    },
    onDragChange: (active) => dragging.push(active),
    onReset: options.onReset,
  });
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const key = (key: string, shiftKey = false) => handle.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, cancelable: true }));
  const pointer = (type: string, x = 0, y = 0, button = 0, id = 1) =>
    handle.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        clientX: x,
        clientY: y,
        button,
        pointerId: id,
        isPrimary: true,
      }),
    );
  return {
    handle,
    key,
    pointer,
    commits,
    intents,
    dragging,
    value: () => value,
    captured: () => captured,
    collapses: () => collapses,
    dispose,
  };
}

for (const grow of ["start", "end"] as const)
  test(`attaching sets the ${grow} cue edge on plain markup`, () => {
    const h = setup({ grow });
    expect(h.handle.dataset.resizeEdge).toBe(grow);
    expect(h.handle.dataset.orientation).toBe("vertical");
    expect(h.handle.dataset.resizePhysicalEdge).toBe(grow);
  });

test("double-click delegates reset, ignores an active drag and detaches on disposal", () => {
  const onReset = mock(() => {});
  const h = setup({ onReset });
  const reset = () => h.handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  reset();
  expect(onReset).toHaveBeenCalledTimes(1);
  h.pointer("pointerdown", 100);
  reset();
  expect(onReset).toHaveBeenCalledTimes(1);
  h.pointer("pointerup", 100);
  reset();
  expect(onReset).toHaveBeenCalledTimes(2);
  h.dispose();
  reset();
  expect(onReset).toHaveBeenCalledTimes(2);
});

test("Enter resets the preference, ignores a drag and removes the handler on disposal", () => {
  const onReset = mock(() => {});
  const h = setup({ onReset });
  h.key("Enter");
  expect(onReset).toHaveBeenCalledTimes(1);
  h.pointer("pointerdown", 100);
  h.key("Enter");
  expect(onReset).toHaveBeenCalledTimes(1);
  h.pointer("pointerup", 100);
  h.dispose();
  h.key("Enter");
  expect(onReset).toHaveBeenCalledTimes(1);
});

test("double-click without a reset callback leaves the value alone", () => {
  const h = setup();
  h.handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(h.value()).toBe(24);
  expect(h.commits).toEqual([]);
});

test("keys follow logical growth, clamp, commit and update rounded ARIA", () => {
  const h = setup();
  h.key("ArrowLeft");
  expect(h.value()).toBe(25);
  h.key("ArrowRight", true);
  expect(h.value()).toBe(21);
  h.key("Home");
  expect(h.value()).toBe(20);
  h.key("ArrowRight");
  expect(h.value()).toBe(20);
  h.key("End");
  expect(h.value()).toBe(36);
  expect(h.commits).toEqual([25, 21, 20, 20, 36]);
  expect(h.handle.getAttribute("aria-valuenow")).toBe("36");
  expect(h.intents).toEqual([]);
});

test("keys work without an optional commit callback", () => {
  const h = setup({ commit: false });
  h.key("ArrowLeft");
  expect(h.value()).toBe(25);
});

test("horizontal keys and end growth follow the vertical axis", () => {
  const h = setup({ orientation: "horizontal", grow: "end" });
  h.key("ArrowDown");
  expect(h.value()).toBe(25);
  h.key("ArrowUp", true);
  expect(h.value()).toBe(21);
  h.key("ArrowLeft");
  expect(h.value()).toBe(21);
  h.pointer("pointerdown", 0, 100);
  h.pointer("pointermove", 0, 132);
  h.pointer("pointerup", 0, 132);
  expect(h.value()).toBe(23);
  expect(h.commits.at(-1)).toBe(23);
});

test("RTL reverses logical column growth for keys and pointer", () => {
  const h = setup({ rtl: true });
  h.key("ArrowRight");
  expect(h.value()).toBe(25);
  h.pointer("pointerdown", 100);
  h.pointer("pointermove", 132);
  h.pointer("pointerup", 132);
  expect(h.value()).toBe(27);
});

test("primary drag captures, suppresses selection, emits live values and commits once", () => {
  const h = setup();
  h.pointer("pointerdown", 100, 0, 2);
  expect(h.captured()).toBeUndefined();
  h.pointer("pointerdown", 100);
  expect(h.captured()).toBe(1);
  expect(h.handle.dataset.active).toBe("true");
  expect(document.documentElement.style.getPropertyValue("user-select")).toBe("none");
  h.pointer("pointermove", 60, 0, 0, 2);
  expect(h.value()).toBe(24);
  h.pointer("pointermove", 60);
  expect(h.value()).toBe(26.5);
  expect(h.handle.getAttribute("aria-valuenow")).toBe("26.5");
  h.pointer("pointerup", 60);
  expect(h.commits).toEqual([26.5]);
  expect(h.dragging).toEqual([true, false]);
  expect(h.handle.dataset.active).toBeUndefined();
  expect(h.captured()).toBeUndefined();
  expect(document.documentElement.style.getPropertyValue("user-select")).toBe("");
});

test("collapse arms below the raw threshold, can be disarmed, and replaces commit", () => {
  const h = setup();
  h.pointer("pointerdown", 0);
  h.pointer("pointermove", 144);
  expect(h.value()).toBe(20);
  expect(h.intents).toEqual([true]);
  h.pointer("pointermove", 32);
  expect(h.intents).toEqual([true, false]);
  h.pointer("pointermove", 144);
  h.pointer("pointerup", 144);
  expect(h.collapses()).toBe(1);
  expect(h.commits).toEqual([]);
  expect(h.intents).toEqual([true, false, true, false]);
});

for (const ending of ["pointercancel", "blur", "dispose"] as const)
  test(`${ending} cancels a drag, restores its value and releases selection`, () => {
    const h = setup();
    h.pointer("pointerdown", 0);
    h.pointer("pointermove", 144);
    if (ending === "blur") window.dispatchEvent(new Event("blur"));
    else if (ending === "dispose") h.dispose();
    else h.pointer(ending);
    expect(h.value()).toBe(24);
    expect(h.commits).toEqual([]);
    expect(h.collapses()).toBe(0);
    expect(h.handle.dataset.active).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("user-select")).toBe("");
  });
