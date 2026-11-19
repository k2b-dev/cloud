import { expect, test } from "bun:test";
import { connectFrameMotion, createFrameMotion, type FrameMotion } from "../src/feedback/dialog-frame-motion";
import { createDomTestHarness } from "./dom";

test("holding a CSSOM decimal does not lose the fractional layout unit it represents", () => {
  const dom = createDomTestHarness();
  const dialog = document.createElement("dialog");
  const level = document.createElement("div");
  dialog.append(level);
  dom.root.append(dialog);
  // CSSOM serializes this layout height to six significant digits. A layout engine truncates a
  // specified length to its layout units; feeding the shorter decimal back loses one unit.
  const natural = 284 + 63 / 64;
  dialog.style.height = "284.984px";
  const motion = createFrameMotion(dialog);
  try {
    motion.follow(level);
    const held = Number.parseFloat(dialog.style.height);
    expect(held).toBeGreaterThanOrEqual(natural);
    expect(Math.floor(held * 64) / 64).toBe(natural);
  } finally {
    motion.stop();
    dom.cleanup();
  }
});

test("the imported motion connects once and follows the existing current level", () => {
  const dom = createDomTestHarness();
  const dialog = document.createElement("dialog");
  const level = document.createElement("div");
  dialog.append(level);
  dom.root.append(dialog);
  const state: { element: HTMLDialogElement; motion?: FrameMotion; stack: { container: HTMLElement; role: "dialog" }[] } = {
    element: dialog,
    stack: [{ container: level, role: "dialog" }],
  };
  try {
    connectFrameMotion(state);
    const motion = state.motion;
    expect(motion).toBeDefined();
    expect(dialog.style.height).not.toBe("");
    connectFrameMotion(state);
    expect(state.motion).toBe(motion);
    expect(dialog.querySelectorAll("[data-k2b-dialog-live]")).toHaveLength(1);
  } finally {
    state.motion?.stop();
    dom.cleanup();
  }
});
