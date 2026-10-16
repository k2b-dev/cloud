import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { createPrintDiagrams } from "./note-print-diagrams";

const figure = (source: string) =>
  `<figure class="notebook-book-mermaid"><figcaption>A path</figcaption><pre><code class="language-mermaid">${source}</code></pre></figure>`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>';
const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

test("serial diagram rendering aborts stale runs, caches current sources and prunes removed ones", async () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  let finish!: (svg: string) => void;
  let active = 0;
  let maxActive = 0;
  let loads = 0;
  const copy = createPrintDiagrams(dom.root, async () => {
    loads++;
    return async (source, signal) => {
      signals.push(signal);
      calls.push(source);
      maxActive = Math.max(maxActive, ++active);
      const result = await new Promise<string>((resolve) => {
        finish = resolve;
      });
      active--;
      return result;
    };
  });
  try {
    dom.root.innerHTML = figure("old") + figure("never-started");
    copy.refresh();
    await settle();
    expect(calls).toEqual(["old"]);
    dom.root.innerHTML = figure("current") + figure("current");
    copy.refresh();
    expect(signals[0]!.aborted).toBe(true);
    finish(svg);
    await settle();
    expect(calls).toEqual(["old", "current"]);
    expect(dom.root.querySelector("img")).toBeNull();
    finish(svg);
    await settle();
    expect(dom.root.querySelectorAll("img")).toHaveLength(2);
    expect(dom.root.querySelector("svg")).toBeNull();
    expect(dom.root.querySelector("img")?.getAttribute("src")).toStartWith("data:image/svg+xml");
    expect(dom.root.querySelector("img")?.alt).toBe("A path");
    expect(maxActive).toBe(1);
    expect(loads).toBe(1);
    dom.root.innerHTML = figure("current");
    copy.refresh();
    // Cached SVGs are installed synchronously for beforeprint.
    expect(dom.root.querySelectorAll("img")).toHaveLength(1);
    expect(calls).toEqual(["old", "current"]);
    dom.root.replaceChildren();
    copy.refresh();
    dom.root.innerHTML = figure("current");
    copy.refresh();
    await settle();
    expect(calls).toEqual(["old", "current", "current"]);
    copy.dispose();
    finish(svg);
    await settle();
    expect(dom.root.querySelector("img")).toBeNull();
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

test("notes without diagrams never load Mermaid; failures retain readable source", async () => {
  const dom = createDomTestHarness();
  let loads = 0;
  const copy = createPrintDiagrams(dom.root, async () => {
    loads++;
    return async () => {
      throw new Error("Invalid diagram");
    };
  });
  try {
    dom.root.textContent = "A plain note";
    copy.refresh();
    await settle();
    expect(loads).toBe(0);
    dom.root.innerHTML = figure("invalid");
    copy.refresh();
    await settle();
    expect(loads).toBe(1);
    expect(dom.root.querySelector("code")?.textContent).toBe("invalid");
    expect(dom.root.querySelector("img")).toBeNull();
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

test("a newly mounted note waits for the disposed note's unabortable render", async () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  let finish!: (value: string) => void;
  const first = createPrintDiagrams(dom.root, async () => async () => {
    calls.push("first");
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const nextRoot = document.createElement("article");
  dom.root.append(nextRoot);
  const next = createPrintDiagrams(nextRoot, async () => async () => {
    calls.push("next");
    return svg;
  });
  try {
    dom.root.insertAdjacentHTML("afterbegin", figure("old"));
    first.refresh();
    await settle();
    first.dispose();
    nextRoot.innerHTML = figure("new");
    next.refresh();
    await settle();
    expect(calls).toEqual(["first"]);
    finish(svg);
    await settle();
    expect(calls).toEqual(["first", "next"]);
    expect(nextRoot.querySelectorAll("img")).toHaveLength(1);
  } finally {
    first.dispose();
    next.dispose();
    dom.cleanup();
  }
});
