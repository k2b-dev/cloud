import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import * as book from "../../../../lib/book-renderer";
import { createNotePrintCopy } from "./note-print-copy";

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(() => jest.useRealTimers());

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const idleCallbacks = () => {
  const pending = new Map<number, IdleRequestCallback>();
  let id = 0;
  const request = mock((callback: IdleRequestCallback) => {
    pending.set(++id, callback);
    return id;
  });
  const cancel = mock((id: number) => {
    pending.delete(id);
  });
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: request });
  Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: cancel });
  return {
    pending,
    cancel,
    flush() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 50 });
    },
  };
};
const printMedia = () => {
  const media = window.matchMedia("print");
  let matches = false;
  Object.defineProperty(media, "matches", { configurable: true, get: () => matches });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  return (value: boolean) => {
    matches = value;
    media.dispatchEvent(Object.assign(new Event("change"), { matches }));
  };
};

test("idle import and debounced typing never render the Book; print renders the latest content once", async () => {
  const dom = createDomTestHarness();
  const idle = idleCallbacks();
  const render = spyOn(book, "renderNotebookBook");
  let markdown = "# First note\n\nOriginal content.";
  let locale = "en";
  const copy = createNotePrintCopy(dom.root, { notebookId: "book01", noteId: "note01", markdown: () => markdown, locale: () => locale });
  try {
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
    expect(idle.pending.size).toBe(1);
    // Typing must not cancel the mount's idle import.
    copy.changed();
    idle.flush();
    await settle();
    for (let i = 0; i < 3; i++) {
      markdown = `# Edit ${i}\n\nLatest text ${i}.`;
      copy.changed();
      jest.advanceTimersByTime(1999);
      expect(idle.pending.size).toBe(0);
      copy.changed();
      jest.advanceTimersByTime(2000);
      expect(idle.pending.size).toBe(1);
      idle.flush();
      await settle();
    }
    expect(render).not.toHaveBeenCalled();
    expect(dom.root.childNodes).toHaveLength(0);
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
    window.dispatchEvent(new Event("beforeprint"));
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]?.[0].markdown).toBe(markdown);
    expect(dom.root.textContent).toContain("Latest text 2.");
    const first = dom.root.firstChild;
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.firstChild).toBe(first);
    expect(render).toHaveBeenCalledTimes(1);
    markdown = "> **History incomplete** Saved history is incomplete.\n\n# Latest note\n\nThe latest content.\n\n![Square](/square.svg)";
    copy.changed();
    jest.advanceTimersByTime(2000);
    idle.flush();
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(dom.root.firstChild).toBe(first);
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.textContent).toContain("The latest content.");
    expect(dom.root.textContent).toContain("History incomplete");
    expect(dom.root.textContent).not.toContain("Latest text 2.");
    expect(dom.root.querySelector("img")?.loading).toBe("eager");
    locale = "de";
    copy.changed();
    window.dispatchEvent(new Event("beforeprint"));
    expect(render).toHaveBeenCalledTimes(3);
    expect(render.mock.calls[2]?.[0].locale).toBe("de");
    copy.dispose();
    markdown = "# Disposed";
    copy.changed();
    jest.advanceTimersByTime(2000);
    idle.flush();
    window.dispatchEvent(new Event("beforeprint"));
    expect(render).toHaveBeenCalledTimes(3);
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
    expect(dom.root.childNodes).toHaveLength(0);
  } finally {
    copy.dispose();
    render.mockRestore();
    dom.cleanup();
  }
});

test("unmount before idle cancels work and cannot publish a late region", () => {
  const dom = createDomTestHarness();
  const idle = idleCallbacks();
  const copy = createNotePrintCopy(dom.root, {
    notebookId: "book01",
    noteId: "note02",
    markdown: () => "# Not mounted",
    locale: () => "en",
  });
  try {
    copy.dispose();
    expect(idle.cancel).toHaveBeenCalledWith(1);
    idle.flush();
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

test("the timeout idle fallback imports only; print-media entry renders the current markdown", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: undefined });
  const print = printMedia();
  let markdown = "# First";
  const copy = createNotePrintCopy(dom.root, { notebookId: "book01", noteId: "note02", markdown: () => markdown, locale: () => "en" });
  try {
    jest.advanceTimersByTime(0);
    await settle();
    expect(dom.root.childNodes).toHaveLength(0);
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
    markdown = "# Print media\n\nCurrent definition.";
    copy.changed();
    print(true);
    expect(dom.root.textContent).toContain("Current definition.");
    const first = dom.root.firstChild;
    print(true);
    expect(dom.root.firstChild).toBe(first);
    markdown = "# Still on screen";
    print(false);
    expect(dom.root.firstChild).toBe(first);
    copy.dispose();
    print(true);
    expect(dom.root.childNodes).toHaveLength(0);
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

test("an idle import completing in print media renders; disposal prevents a late copy", async () => {
  const dom = createDomTestHarness();
  const idle = idleCallbacks();
  const print = printMedia();
  const options = { notebookId: "book01", noteId: "note02", markdown: () => "# Early print\n\n![Square](/square.svg)", locale: () => "en" };
  const copy = createNotePrintCopy(dom.root, options);
  let next: ReturnType<typeof createNotePrintCopy> | undefined;
  try {
    idle.flush();
    print(true);
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
    await settle();
    expect(dom.root.hasAttribute("data-print-region")).toBe(true);
    expect(dom.root.textContent).toContain("Early print");
    expect(dom.root.querySelector("img")?.loading).toBe("eager");
    copy.dispose();
    next = createNotePrintCopy(dom.root, options);
    idle.flush();
    next.dispose();
    await settle();
    expect(dom.root.childNodes).toHaveLength(0);
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
  } finally {
    copy.dispose();
    next?.dispose();
    dom.cleanup();
  }
});

test("a failed print clears the region and warns; the next print retries", async () => {
  const dom = createDomTestHarness();
  const idle = idleCallbacks();
  const render = spyOn(book, "renderNotebookBook");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let markdown = "# First";
  const copy = createNotePrintCopy(dom.root, { notebookId: "book01", noteId: "note01", markdown: () => markdown, locale: () => "en" });
  try {
    idle.flush();
    await settle();
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.hasAttribute("data-print-region")).toBe(true);
    markdown = "# Retry";
    render.mockImplementationOnce(() => {
      throw new Error("Cannot render");
    });
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.childNodes).toHaveLength(0);
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.hasAttribute("data-print-region")).toBe(true);
    expect(dom.root.textContent).toContain("Retry");
  } finally {
    copy.dispose();
    render.mockRestore();
    warn.mockRestore();
    dom.cleanup();
  }
});
