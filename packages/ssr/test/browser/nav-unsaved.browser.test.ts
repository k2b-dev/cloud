import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as swap from "../../src/nav-swap";
import { protectUnsavedInput } from "../../src/nav-unsaved";
import { allowsLeave, onBeforeLeave } from "../../src/nav-veto";

const target = "https://example.test/app/B";
const disposers: Array<() => void> = [];
const leave = (delta?: number) => {
  const restore = allowsLeave(document.querySelector("main")!, new URL(target), delta);
  // A vetoed click or swapPage() is restored at once, as nav does.
  restore?.();
  return restore === undefined;
};
const asksBeforeUnload = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let swapped: ReturnType<typeof spyOn<typeof swap, "swapPage">>;
beforeEach(() => {
  document.body.innerHTML = "<main data-nav-root><h1>A</h1></main>";
  swapped = spyOn(swap, "swapPage").mockImplementation(async () => {
    leave();
  });
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  swapped.mockRestore();
});

test("a confirmed swap passes once and a fallback document load does not ask again", async () => {
  disposers.push(protectUnsavedInput({ dirty: () => true, confirm: () => true }));
  expect(leave()).toBe(false);
  await settle();
  expect(swapped.mock.calls).toEqual([[target]]);
  expect(asksBeforeUnload()).toBe(false);
});

test("a confirmed swap that another guard vetoes protects the input again", async () => {
  disposers.push(protectUnsavedInput({ dirty: () => true, confirm: () => true }));
  let vetoes = 0;
  disposers.push(
    onBeforeLeave((event) => {
      vetoes++;
      event.preventDefault();
    }),
  );
  expect(leave()).toBe(false);
  await settle();
  expect(swapped).toHaveBeenCalledTimes(1);
  expect(vetoes).toBe(1);
  await settle();
  expect(asksBeforeUnload()).toBe(true);
});

test("a declined question keeps protecting and navigates nowhere", async () => {
  disposers.push(protectUnsavedInput({ dirty: () => true, confirm: () => false }));
  expect(leave()).toBe(false);
  await settle();
  expect(swapped).not.toHaveBeenCalled();
  expect(asksBeforeUnload()).toBe(true);
});

test("an answer after disposal navigates nowhere", async () => {
  const answer = Promise.withResolvers<boolean>();
  const go = spyOn(history, "go").mockImplementation(() => {});
  try {
    const dispose = protectUnsavedInput({ dirty: () => true, confirm: () => answer.promise });
    expect(leave(-1)).toBe(false);
    await settle();
    dispose();
    answer.resolve(true);
    await settle();
    expect(go).not.toHaveBeenCalled();
    expect(swapped).not.toHaveBeenCalled();
  } finally {
    go.mockRestore();
  }
});

test("one question at a time; its answer applies to the newest navigation", async () => {
  const answer = Promise.withResolvers<boolean>();
  const asked: string[] = [];
  const go = spyOn(history, "go").mockImplementation(() => {});
  try {
    disposers.push(
      protectUnsavedInput({
        dirty: () => true,
        confirm: (url) => {
          asked.push(url.pathname);
          return answer.promise;
        },
      }),
    );
    expect(leave()).toBe(false);
    await settle();
    expect(leave(-1)).toBe(false);
    answer.resolve(true);
    await settle();
    expect(asked).toEqual(["/app/B"]);
    expect(go.mock.calls).toEqual([[-1]]);
    expect(swapped).not.toHaveBeenCalled();
  } finally {
    go.mockRestore();
  }
});

test("clean input is never asked and a document load passes", async () => {
  let asked = 0;
  disposers.push(
    protectUnsavedInput({
      dirty: () => false,
      confirm: () => {
        asked++;
        return true;
      },
    }),
  );
  expect(leave()).toBe(true);
  expect(asksBeforeUnload()).toBe(false);
  expect(asked).toBe(0);
});
