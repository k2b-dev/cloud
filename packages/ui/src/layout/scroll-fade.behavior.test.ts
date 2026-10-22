import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../test/dom";
import { installScrollFades } from "./scroll-fade";

describe.skipIf(isServer)("scroll fade invalidations", () => {
  let dom: DomTestHarness;
  let stop = () => {};
  let nextFrame: number;
  let events: string[];
  let frames: Map<number, FrameRequestCallback>;
  let requestFrame: ReturnType<typeof spyOn<typeof globalThis, "requestAnimationFrame">>;
  let cancelFrame: ReturnType<typeof spyOn<typeof globalThis, "cancelAnimationFrame">>;
  beforeEach(() => {
    dom = createDomTestHarness();
    nextFrame = 0;
    events = [];
    frames = new Map();
    requestFrame = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    cancelFrame = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    stop();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
    dom.cleanup();
  });
  const port = (name: string) => {
    const body = dom.document.createElement("div");
    body.dataset.scrollFadeMode = "both";
    Object.defineProperty(body, "scrollHeight", {
      get: () => {
        events.push(`read:${name}`);
        return 600;
      },
    });
    Object.defineProperty(body, "clientHeight", { get: () => 100 });
    const setAttribute = body.setAttribute.bind(body);
    body.setAttribute = (attribute, value) => {
      if (attribute === "data-scroll-fade") events.push(`write:${name}`);
      setAttribute(attribute, value);
    };
    dom.root.append(body);
    return body;
  };
  test("keeps initial edges and reads all invalidated ports once before writing", () => {
    const a = port("a");
    const b = port("b");
    stop = installScrollFades(dom.root);
    expect(a.getAttribute("data-scroll-fade")).toBe("bottom");
    expect(b.getAttribute("data-scroll-fade")).toBe("bottom");
    events = [];
    a.scrollTop = 50;
    b.scrollTop = 50;
    for (let repeat = 0; repeat < 3; repeat++) {
      a.dispatchEvent(new Event("scroll"));
      b.dispatchEvent(new Event("scroll"));
    }
    expect(events).toEqual([]);
    expect(frames.size).toBe(1);
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
    expect(events).toEqual(["read:a", "read:b", "write:a", "write:b"]);
    expect(a.getAttribute("data-scroll-fade")).toBe("both");
    expect(b.getAttribute("data-scroll-fade")).toBe("both");
  });
  test("only the last observer cancels pending work and removes the fade", () => {
    const body = port("a");
    const first = installScrollFades(dom.root);
    stop = installScrollFades(dom.root);
    events = [];
    body.dispatchEvent(new Event("scroll"));
    first();
    expect(frames.size).toBe(1);
    expect(body.getAttribute("data-scroll-fade")).toBe("bottom");
    stop();
    stop = () => {};
    expect(frames.size).toBe(0);
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(body.hasAttribute("data-scroll-fade")).toBe(false);
  });
});
