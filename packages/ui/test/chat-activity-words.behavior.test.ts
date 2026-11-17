import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const FIRST = "Denkt nach";
const WORDS = ["Grübelt", "Tüftelt", "Spitzt den Bleistift"];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One activity row with changing words, starting `elapsedMs` into its phase. */
const mount = async (elapsedMs: number, options: { reduced?: boolean } = {}) => {
  const dom = createDomTestHarness();
  if (options.reduced) dom.document.documentElement.setAttribute("data-k2b-motion", "reduced");
  const { Chat } = await import("../src/chat");
  const [elapsed] = createSignal(elapsedMs);
  const dispose = render(
    () =>
      createComponent(Chat.Activity, {
        tone: "ai",
        busy: true,
        get label() {
          return createComponent(Chat.Activity.Words, { first: FIRST, words: WORDS, elapsedMs: elapsed(), announce: "Gustav denkt nach" });
        },
        trailing: "3 s",
      }),
    dom.root,
  );
  const row = dom.root.querySelector<HTMLElement>(".k2b-chat-activity")!;
  const words = () => [...dom.root.querySelectorAll(".k2b-chat-activity__word")].map((node) => node.textContent);
  return {
    dom,
    row,
    words,
    close: () => {
      dispose();
      dom.cleanup();
    },
  };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("the first frame shows the word for the host's time, as the server did", async () => {
    const view = await mount(5_400);
    expect(view.words()).toEqual(["Tüftelt"]);
    view.close();
  });

  test("at the boundary the old word fades out first, then the next one fades in; never two words", async () => {
    const view = await mount(2_950);
    const seen: (string | null)[][] = [];
    const observer = new MutationObserver(() => seen.push(view.words()));
    observer.observe(view.dom.root, { subtree: true, childList: true, characterData: true, attributes: true });
    expect(view.words()).toEqual([FIRST]);
    await wait(120);
    // Fading out: still the old word, alone.
    expect(view.words()).toEqual([FIRST]);
    expect(view.dom.root.querySelector(".k2b-chat-activity__word")?.getAttribute("data-phase")).toBe("out");
    await wait(160);
    expect(view.words()).toEqual(["Grübelt"]);
    expect(view.dom.root.querySelector(".k2b-chat-activity__word")?.getAttribute("data-phase")).toBe("in");
    observer.disconnect();
    expect(seen.every((frame) => frame.length === 1)).toBe(true);
    // Words and seconds are silent; the row holds no status of its own.
    expect(view.dom.root.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(view.dom.root.querySelector(".k2b-chat-activity__words")?.getAttribute("aria-hidden")).toBe("true");
    view.close();
  });

  test("a row that a pointer only arrives on, or a finger taps, keeps changing its words", async () => {
    const view = await mount(2_950);
    // A row that only arrives under a resting pointer holds nothing; a finger's tap neither.
    view.row.dispatchEvent(new Event("pointerenter"));
    view.row.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType: "touch" }));
    await wait(250);
    expect(view.words()).toEqual(["Grübelt"]);
    view.close();
  });

  test("a mouse moving on the row holds the word; leaving shows the word of the current time at once", async () => {
    const view = await mount(2_950);
    view.row.dispatchEvent(Object.assign(new Event("pointermove"), { pointerType: "mouse" }));
    await wait(250);
    expect(view.words()).toEqual([FIRST]);
    view.row.dispatchEvent(new Event("pointerleave"));
    expect(view.words()).toEqual(["Grübelt"]);
    expect(view.dom.root.querySelector(".k2b-chat-activity__word")?.getAttribute("data-phase")).toBe("still");
    view.close();
  });

  test("a hidden tab changes nothing and shows the current word on return, without catching up", async () => {
    const view = await mount(2_950);
    Object.defineProperty(view.dom.document, "hidden", { configurable: true, get: () => true });
    try {
      await wait(250);
      expect(view.words()).toEqual([FIRST]);
    } finally {
      Object.defineProperty(view.dom.document, "hidden", { configurable: true, get: () => false });
    }
    view.dom.document.dispatchEvent(new Event("visibilitychange"));
    expect(view.words()).toEqual(["Grübelt"]);
    expect(view.dom.root.querySelector(".k2b-chat-activity__word")?.getAttribute("data-phase")).toBe("still");
    Reflect.deleteProperty(view.dom.document, "hidden");
    view.close();
  });

  test("reduced motion changes nothing; the resting first word is there from the first frame", async () => {
    const view = await mount(2_950, { reduced: true });
    try {
      const rest = () => view.dom.root.querySelector(".k2b-chat-activity__word-rest")?.textContent;
      expect(rest()).toBe(FIRST);
      await wait(250);
      // No fade starts: the stylesheet shows the resting word, and the hidden word does not churn.
      expect(view.dom.root.querySelector(".k2b-chat-activity__word")?.getAttribute("data-phase")).toBe("still");
      expect(rest()).toBe(FIRST);
    } finally {
      view.close();
    }
  });
}

if (!isServer)
  test("the phase is announced once through the page's live region, outside the busy row", async () => {
    const view = await mount(5_400);
    try {
      await wait(400);
      const lines = () =>
        [...view.dom.document.querySelectorAll("[aria-live] div")]
          .map((line) => line.textContent)
          .filter((text) => text === "Gustav denkt nach");
      expect(lines()).toHaveLength(1);
      expect(view.dom.document.querySelector("[aria-live]")?.closest('[aria-busy="true"]')).toBeNull();
      await wait(300);
      expect(lines().length).toBeLessThanOrEqual(1);
    } finally {
      view.close();
    }
  });
