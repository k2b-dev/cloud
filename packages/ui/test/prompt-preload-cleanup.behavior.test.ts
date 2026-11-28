import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { trackLoad } from "../src/internal/pending-loads";
import { createDomTestHarness } from "./dom";

// A focus starts @k2b/ui's preload of the prompt form fields (without idle callbacks, the first focus, press or key
// does it). The chunk needs its window while it runs. An app's behavior test that focuses a field and cleans up right
// after must not meet that load once the window is gone (Spaces, W3: "window is not defined" after `cleanup()`), and
// a later page in the same process still gets its fields: a chunk that ran without a window stays broken.

/** The window the globals hold now. */
const currentWindow = (): unknown => Reflect.get(globalThis, "window");

const watchErrors = () => {
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
  const consoleError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  return {
    errors,
    stop: () => {
      console.error = consoleError;
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    },
  };
};

test("a focus right before cleanup leaves no error from the prompt form preload", async () => {
  if (isServer) return;
  const watch = watchErrors();
  try {
    const dom = createDomTestHarness();
    // The library starts its preload listener when it loads in a page, as an island does.
    await import("../src/feedback/prompts");
    const field = dom.document.createElement("input");
    field.setAttribute("aria-label", "Name");
    dom.root.append(field);
    field.focus();
    // As most tests do it: not awaited.
    void dom.cleanup();
    // Long enough for the form chunk to load and run.
    await Bun.sleep(500);
    expect(watch.errors).toEqual([]);

    // The next page in the process loads the fields as usual.
    const next = createDomTestHarness();
    try {
      const { loadPromptForm } = await import("../src/feedback/prompt-form-loader");
      expect(typeof (await loadPromptForm()).TextInput).toBe("function");
    } finally {
      await next.cleanup();
    }
    expect(watch.errors).toEqual([]);
  } finally {
    watch.stop();
  }
});

test("a harness that waits for a load hands over to the next harness, and the last cleanup restores the globals", async () => {
  if (isServer) return;
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  let finish = () => {};
  const load = trackLoad(new Promise<void>((resolve) => (finish = resolve)));

  const first = createDomTestHarness();
  const firstClosed = first.cleanup();
  // The load still runs, so the first window stays.
  expect(currentWindow()).toBe(first.window);

  // The next harness starts before the load ends (a test that did not await): it takes over the globals at once.
  const second = createDomTestHarness();
  expect(currentWindow()).toBe(second.window);
  await firstClosed;
  expect(currentWindow()).toBe(second.window);

  const secondClosed = second.cleanup();
  expect(currentWindow()).toBe(second.window);
  finish();
  await load;
  await secondClosed;
  expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(before);
});
