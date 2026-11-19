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
    motion.follow(level, true);
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
  const state: {
    element: HTMLDialogElement;
    motion?: FrameMotion;
    stack: { container: HTMLElement; role: "dialog"; follow: boolean }[];
  } = {
    element: dialog,
    stack: [{ container: level, role: "dialog", follow: true }],
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

test("non-opted-in levels create no content observers and hold no height, including after an opted-in level", () => {
  const dom = createDomTestHarness();
  const Resize = globalThis.ResizeObserver;
  const Mutation = globalThis.MutationObserver;
  let resizeCount = 0;
  let mutationCount = 0;
  globalThis.ResizeObserver = class extends Resize {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      resizeCount++;
    }
  };
  globalThis.MutationObserver = class extends Mutation {
    constructor(callback: MutationCallback) {
      super(callback);
      mutationCount++;
    }
  };
  const dialog = document.createElement("dialog");
  const plain = document.createElement("div");
  const form = document.createElement("div");
  dialog.append(plain, form);
  dom.root.append(dialog);
  const motion = createFrameMotion(dialog);
  try {
    motion.follow(plain);
    expect(resizeCount).toBe(0);
    expect(mutationCount).toBe(0);
    expect(dialog.style.height).toBe("");
    motion.follow(form, true);
    expect(resizeCount).toBe(1);
    expect(mutationCount).toBe(1);
    motion.begin(form);
    motion.arrive(plain, () => {});
    expect(dialog.style.height).toBe("");
    expect(resizeCount).toBe(1);
    expect(mutationCount).toBe(1);
  } finally {
    motion.stop();
    globalThis.ResizeObserver = Resize;
    globalThis.MutationObserver = Mutation;
    dom.cleanup();
  }
});
