import { expect, mock, test } from "bun:test";
import type { connectFrameMotion } from "../src/feedback/dialog-frame-motion";
import { createDomTestHarness } from "./dom";

// Replacing the rejected import boundary models a chunk that becomes available again,
// without preloading the real module or adding a loader hook to the product.
mock.module("../src/feedback/dialog-frame-motion", () => Promise.reject(new Error("first chunk request failed")));
const { createDialogCore } = await import("../src/feedback/dialog-core");

test("a successful retry hands the existing frame and its current level to the imported motion", async () => {
  const dom = createDomTestHarness();
  const core = createDialogCore();
  const connections: { element?: HTMLDialogElement; level?: HTMLElement; announced?: HTMLElement }[] = [];
  const view = (title: string) => () => {
    const heading = document.createElement("h2");
    heading.textContent = title;
    return heading;
  };
  try {
    void core.open(view("Editor"));
    await Bun.sleep(50);
    const dialog = dom.document.querySelector("dialog")!;
    expect(connections).toHaveLength(0);
    mock.module("../src/feedback/dialog-frame-motion", () => ({
      connectFrameMotion: (state: Parameters<typeof connectFrameMotion>[0], announced?: Parameters<typeof connectFrameMotion>[1]) => {
        connections.push({ element: state.element, level: state.stack.at(-1)?.container, announced: announced?.container });
      },
      afterExitTransitions: (_: HTMLElement, done: () => void) => {
        done();
        return () => {};
      },
    }));
    void core.open(view("Recovered"), { ariaLabel: "Recovered" });
    await Bun.sleep(100);
    expect(dom.document.querySelector("dialog")).toBe(dialog);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.element).toBe(dialog);
    expect(connections[0]?.level?.textContent).toBe("Recovered");
    expect(connections[0]?.announced).toBe(connections[0]?.level);
    void core.open(view("Next"), { ariaLabel: "Next" });
    await Bun.sleep(100);
    expect(connections).toHaveLength(2);
    expect(connections[1]?.element).toBe(dialog);
    expect(connections[1]?.level?.textContent).toBe("Next");
  } finally {
    while (core.isOpen()) core.close();
    mock.restore();
    dom.cleanup();
  }
});
