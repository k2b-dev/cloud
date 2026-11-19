import { expect, mock, test } from "bun:test";
import type { FrameMotion } from "../src/feedback/dialog-frame-motion";
import { createDomTestHarness } from "./dom";

// Replacing the rejected import boundary models a chunk that becomes available again,
// without preloading the real module or adding a loader hook to the product.
mock.module("../src/feedback/dialog-frame-motion", () => Promise.reject(new Error("first chunk request failed")));
const { createDialogCore } = await import("../src/feedback/dialog-core");

test("a successful retry initializes an existing frame once and follows its current top level", async () => {
  const dom = createDomTestHarness();
  const core = createDialogCore();
  const followed: HTMLElement[] = [];
  const announcements: string[] = [];
  let creations = 0;
  const view = (title: string) => () => {
    const heading = document.createElement("h2");
    heading.textContent = title;
    return heading;
  };
  try {
    void core.open(view("Editor"));
    await Bun.sleep(50);
    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.querySelector("[data-k2b-dialog-live]")).toBeNull();
    mock.module("../src/feedback/dialog-frame-motion", () => ({
      createFrameMotion: (): FrameMotion => {
        creations++;
        return {
          begin: () => {},
          arrive: (_, left) => left(),
          announce: (role) => {
            announcements.push(role);
          },
          follow: (level) => {
            followed.push(level);
          },
          stop: () => {},
          position: () => {},
          freeze: () => () => {},
        };
      },
      afterExitTransitions: (_: HTMLElement, done: () => void) => {
        done();
        return () => {};
      },
    }));
    void core.open(view("Recovered"), { ariaLabel: "Recovered" });
    await Bun.sleep(100);
    expect(dom.document.querySelector("dialog")).toBe(dialog);
    expect(creations).toBe(1);
    expect(followed.at(-1)?.textContent).toBe("Recovered");
    expect(announcements).toEqual(["dialog"]);
    void core.open(view("Next"), { ariaLabel: "Next" });
    await Bun.sleep(100);
    expect(creations).toBe(1);
    expect(announcements).toEqual(["dialog", "dialog"]);
  } finally {
    while (core.isOpen()) core.close();
    mock.restore();
    dom.cleanup();
  }
});
