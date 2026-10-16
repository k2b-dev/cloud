import { expect, mock, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { createNotePrintCopy } from "./note-print-copy";

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 100 && !until(); i++) await Bun.sleep(10);
  expect(until()).toBe(true);
};

test("idle import, synchronous print refresh, unchanged content and disposal", async () => {
  const dom = createDomTestHarness();
  let markdown = "# First note\n\nOriginal content.";
  const idle = new Map<number, IdleRequestCallback>();
  let id = 0;
  const requestIdle = mock((callback: IdleRequestCallback) => {
    idle.set(++id, callback);
    return id;
  });
  const cancelIdle = mock((id: number) => {
    idle.delete(id);
  });
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: requestIdle });
  Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: cancelIdle });
  const article = document.createElement("article");
  dom.root.append(article);
  const copy = createNotePrintCopy(article, { notebookId: "book01", noteId: "note01", markdown: () => markdown, locale: () => "en" });
  try {
    // An immediate print must leave the shell fallback eligible.
    window.dispatchEvent(new Event("beforeprint"));
    expect(article.hasAttribute("data-print-region")).toBe(false);
    expect(idle.size).toBe(1);
    for (const callback of idle.values()) callback({ didTimeout: false, timeRemaining: () => 50 });
    idle.clear();
    await settle(() => article.hasAttribute("data-print-region"));
    const first = article.firstChild;
    window.dispatchEvent(new Event("beforeprint"));
    expect(article.firstChild).toBe(first);
    markdown = "> **History incomplete** Saved history is incomplete.\n\n# Latest note\n\nThe latest content.\n\n![Square](/square.svg)";
    copy.changed();
    expect(article.textContent).toContain("Original content.");
    window.dispatchEvent(new Event("beforeprint"));
    expect(article.textContent).toContain("The latest content.");
    expect(article.textContent).toContain("History incomplete");
    expect(article.textContent).not.toContain("Original content.");
    expect(article.querySelector("img")?.loading).toBe("eager");
    copy.dispose();
    markdown = "# Disposed";
    window.dispatchEvent(new Event("beforeprint"));
    expect(article.hasAttribute("data-print-region")).toBe(false);
    expect(article.childNodes).toHaveLength(0);
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

test("unmount before idle cancels work and cannot publish a late region", () => {
  const dom = createDomTestHarness();
  const requestIdle = mock(() => 7);
  const cancelIdle = mock(() => {});
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: requestIdle });
  Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: cancelIdle });
  const copy = createNotePrintCopy(dom.root, {
    notebookId: "book01",
    noteId: "note02",
    markdown: () => "# Not mounted",
    locale: () => "en",
  });
  try {
    copy.dispose();
    expect(cancelIdle).toHaveBeenCalledWith(7);
    window.dispatchEvent(new Event("beforeprint"));
    expect(dom.root.hasAttribute("data-print-region")).toBe(false);
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

test("the timeout idle fallback and print-media entry render the current markdown", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: undefined });
  const media = window.matchMedia("print");
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => media });
  let markdown = "# First";
  const copy = createNotePrintCopy(dom.root, { notebookId: "book01", noteId: "note02", markdown: () => markdown, locale: () => "en" });
  try {
    await settle(() => dom.root.hasAttribute("data-print-region"));
    markdown = "# Print media\n\nCurrent definition.";
    copy.changed();
    media.dispatchEvent(Object.assign(new Event("change"), { matches: true }));
    expect(dom.root.textContent).toContain("Current definition.");
    const first = dom.root.firstChild;
    media.dispatchEvent(Object.assign(new Event("change"), { matches: true }));
    expect(dom.root.firstChild).toBe(first);
    markdown = "# Still on screen";
    media.dispatchEvent(Object.assign(new Event("change"), { matches: false }));
    expect(dom.root.firstChild).toBe(first);
    copy.dispose();
    media.dispatchEvent(Object.assign(new Event("change"), { matches: true }));
    expect(dom.root.childNodes).toHaveLength(0);
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});
