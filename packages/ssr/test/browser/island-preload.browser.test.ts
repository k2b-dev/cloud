import { afterEach, expect, spyOn, test } from "bun:test";
import { toJSON } from "seroval";
import { disposeIslands, islandsPending, mount, mountIslands } from "../../src/mount";

afterEach(() => {
  disposeIslands(document);
  document.body.replaceChildren();
});

const wrapper = (id: string) => {
  const element = document.createElement("solid-island");
  element.dataset.id = id;
  element.dataset.props = JSON.stringify(toJSON({}));
  const input = document.createElement("input");
  element.append(input);
  document.body.append(element);
  input.focus();
  return { element, input, selector: `solid-island[data-id="${id}"]` };
};

test("preloading retains the server DOM and focus until the first complete client render", async () => {
  const { element, input, selector } = wrapper("preload-pending");
  const ready = Promise.withResolvers<void>();
  const Component = Object.assign(() => document.createElement("input"), { preload: () => ready.promise });
  mount(Component, selector);
  mountIslands(element);
  expect(element.firstChild).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(islandsPending(element)).toBe(true);
  ready.resolve();
  await Bun.sleep(0);
  expect(element.firstChild).not.toBe(input);
  expect(element.childElementCount).toBe(1);
  expect(document.activeElement).toBe(element.firstElementChild);
  expect(islandsPending(element)).toBe(false);
  const rendered = element.firstChild;
  mountIslands(element);
  expect(element.firstChild).toBe(rendered);
  const later = wrapper("preload-pending");
  mountIslands(later.element);
  await Bun.sleep(0);
  expect(later.element.firstChild).not.toBe(later.input);
});

test("a failed preload reports its error and offers a retry that loads again", async () => {
  const { element, input, selector } = wrapper("preload-retry");
  input.value = "Still typing";
  const failure = new Error("missing chunk");
  let attempts = 0;
  let retry: (() => void) | undefined;
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) throw new Error("Expected an island error");
    event.preventDefault();
    expect(event.detail.error).toBe(failure);
    retry = event.detail.reset;
  };
  element.addEventListener("ssr:island-error", listener);
  const Component = Object.assign(() => "ready", {
    preload: async () => {
      if (++attempts === 1) throw failure;
    },
  });
  const report = spyOn(globalThis, "reportError");
  try {
    mount(Component, selector);
    await Bun.sleep(0);
    expect(element.firstChild).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Still typing");
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(element.querySelector("button")?.textContent).toBe("Try again");
    expect(islandsPending(element)).toBe(false);
    expect(report).not.toHaveBeenCalled();
    expect(retry).toBeDefined();
    element.querySelector("button")!.click();
    await Bun.sleep(0);
    expect(element.textContent).toBe("ready");
    expect(attempts).toBe(2);
  } finally {
    report.mockRestore();
    element.removeEventListener("ssr:island-error", listener);
  }
});

test("entries imported before a swap retain their preparation for late wrappers", async () => {
  const ready = Promise.withResolvers<void>();
  let renders = 0;
  const Component = Object.assign(
    () => {
      renders++;
      return "ready";
    },
    { preload: () => ready.promise },
  );
  const selector = 'solid-island[data-id="preload-swap"]';
  mount(Component, selector);
  const removed = wrapper("preload-swap");
  mountIslands(removed.element);
  removed.element.remove();
  ready.resolve();
  await Bun.sleep(0);
  expect(renders).toBe(0);
  expect(removed.element.firstChild).toBe(removed.input);
  const arriving = wrapper("preload-swap");
  mountIslands(arriving.element);
  await Bun.sleep(0);
  expect(arriving.element.textContent).toBe("ready");
  expect(renders).toBe(1);
});

test("a preload rejected before a swap still gives the arriving wrapper a visible recovery", async () => {
  const failure = new Error("missing prefetched chunk");
  const Component = Object.assign(() => "ready", {
    preload: async () => {
      throw failure;
    },
  });
  mount(Component, 'solid-island[data-id="preload-late-failure"]');
  await Bun.sleep(0);
  const arriving = wrapper("preload-late-failure");
  let reported: unknown;
  arriving.element.addEventListener("ssr:island-error", (event) => {
    if (!(event instanceof CustomEvent)) throw new Error("Expected an island error");
    event.preventDefault();
    reported = event.detail.error;
  });
  mountIslands(arriving.element);
  await Bun.sleep(0);
  expect(reported).toBe(failure);
  expect(arriving.element.querySelector('[role="alert"]')).not.toBeNull();
  expect(arriving.element.querySelector("button")?.textContent).toBe("Try again");
  disposeIslands(arriving.element);
  expect(arriving.element.childNodes).toHaveLength(0);
});
