import { expect, test } from "bun:test";
import { createFrameMotion } from "../src/feedback/dialog-frame-motion";
import { createDomTestHarness } from "./dom";

for (const theme of ["light", "dark"])
  test(`fractional ${theme} content edges report their outer height even when the content box stays unchanged`, () => {
    const dom = createDomTestHarness();
    const Resize = globalThis.ResizeObserver;
    const computed = globalThis.getComputedStyle;
    const request = globalThis.requestAnimationFrame;
    const cancel = globalThis.cancelAnimationFrame;
    const frames = new Map<number, FrameRequestCallback>();
    const observations: ResizeObserverOptions[] = [];
    let delivery: ResizeObserverCallback | undefined;
    let observer: ResizeObserver | undefined;
    let sequence = 0;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        delivery = callback;
        observer = this;
      }
      observe(_target: Element, options: ResizeObserverOptions = {}) {
        observations.push(options);
      }
      unobserve() {}
      disconnect() {}
    };
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++sequence, callback);
      return sequence;
    };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const dialog = document.createElement("dialog");
    const level = document.createElement("div");
    dialog.append(level);
    dom.root.append(dialog);
    dom.document.documentElement.className = theme;
    level.style.cssText = "height:40px;width:100px;padding:0;border:0 solid;box-sizing:content-box";
    dialog.style.width = "100px";
    dialog.getAnimations = () => [];
    const edge = () => Number.parseFloat(level.style.borderBottomWidth) || 0;
    globalThis.getComputedStyle = (element, pseudo) =>
      new Proxy(computed(element, pseudo), {
        get(target, key, receiver) {
          if (element === dialog && key === "height") return dialog.style.height || `${200 + edge()}px`;
          return Reflect.get(target, key, receiver);
        },
      });
    const report = () => {
      if (!delivery || !observer) throw new Error("Expected the content size observer");
      delivery(
        [
          {
            target: level,
            contentRect: new dom.window.DOMRectReadOnly(0, 0, 100, 40),
            borderBoxSize: [{ inlineSize: 100, blockSize: 40 + edge() }],
            contentBoxSize: [{ inlineSize: 100, blockSize: 40 }],
            devicePixelContentBoxSize: [],
          },
        ],
        observer,
      );
    };
    const flush = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    };
    const motion = createFrameMotion(dialog);
    try {
      motion.follow(level);
      flush();
      report();
      flush();
      // Theme-dependent edges and padding belong to layout even when a content-box report is identical.
      level.style.borderBottomWidth = `${theme === "light" ? 63 / 64 : 31 / 64}px`;
      report();
      flush();
      expect(Number.parseFloat(dialog.style.height)).toBeGreaterThanOrEqual(200 + edge());
      expect(Number.parseFloat(dialog.style.height) - (200 + edge())).toBeLessThan(1 / 64);
      expect(observations.every((options) => options.box === "border-box")).toBe(true);
    } finally {
      motion.stop();
      globalThis.ResizeObserver = Resize;
      globalThis.getComputedStyle = computed;
      globalThis.requestAnimationFrame = request;
      globalThis.cancelAnimationFrame = cancel;
      dom.cleanup();
    }
  });
