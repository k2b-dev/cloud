import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { renderNotebookBook } from "../../../../lib/book-renderer";
import { createPrintDiagrams, mermaidFenceSources } from "./note-print-diagrams";

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
    copy.warm(["old", "never-started"]);
    await settle();
    expect(calls).toEqual(["old"]);
    dom.root.innerHTML = figure("current") + figure("current");
    copy.warm(["current"]);
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
    copy.warm([]);
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
    copy.warm([]);
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

test("warming an empty root caches unique sources for synchronous first print and prunes only unused sources", async () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  let loads = 0;
  const copy = createPrintDiagrams(dom.root, async () => {
    loads++;
    return async (source) => {
      calls.push(source);
      return svg;
    };
  });
  try {
    copy.warm(["kept", "removed", "kept"]);
    await settle();
    expect(calls).toEqual(["kept", "removed"]);
    expect(dom.root.childNodes).toHaveLength(0);
    dom.root.innerHTML = figure("kept");
    copy.refresh();
    expect(dom.root.querySelectorAll("img")).toHaveLength(1);
    copy.warm(["next"]);
    await settle();
    expect(calls).toEqual(["kept", "removed", "next"]);
    expect(dom.root.querySelector("img")?.alt).toBe("A path");
    // Keep the source of a figure whose code was already replaced by an image.
    dom.root.innerHTML = figure("kept") + figure("next");
    copy.refresh();
    expect(dom.root.querySelectorAll("img")).toHaveLength(2);
    expect(dom.root.querySelector("img")?.loading).toBe("eager");
    copy.warm([]);
    dom.root.innerHTML = figure("kept") + figure("next");
    copy.refresh();
    expect(dom.root.querySelectorAll("img")).toHaveLength(2);
    dom.root.replaceChildren();
    copy.warm([]);
    copy.warm(["removed"]);
    await settle();
    expect(calls).toEqual(["kept", "removed", "next", "removed"]);
    expect(loads).toBe(1);
    copy.dispose();
    copy.warm(["disposed"]);
    copy.refresh();
    await settle();
    expect(calls).toHaveLength(4);
  } finally {
    copy.dispose();
    dom.cleanup();
  }
});

const fenceCases = [
  { name: "plain", markdown: "```mermaid\nflowchart TD\n A-->B\n```", sources: ["flowchart TD\n A-->B"] },
  ...[1, 2, 3].map((indent) => ({
    name: `indented ${indent} spaces`,
    markdown: `${" ".repeat(indent)}\`\`\`mermaid\n${" ".repeat(indent)}flowchart TD\n${" ".repeat(indent + 1)}A-->B\n A-->C\n${" ".repeat(indent)}\`\`\``,
    sources: ["flowchart TD\n A-->B\nA-->C"],
  })),
  { name: "tilde", markdown: "~~~~mermaid\nflowchart LR\n A-->B\n~~~~", sources: ["flowchart LR\n A-->B"] },
  { name: "extra info words", markdown: "```mermaid title path\nflowchart TD\n A-->B\n```", sources: ["flowchart TD\n A-->B"] },
  { name: "uppercase", markdown: "```MERMAID\nflowchart TD\n A-->B\n```", sources: ["flowchart TD\n A-->B"] },
  { name: "unclosed", markdown: "```mermaid\nflowchart TD\n A-->B", sources: ["flowchart TD\n A-->B"] },
  { name: "unclosed with final newline", markdown: "```mermaid\nflowchart TD\n A-->B\n", sources: ["flowchart TD\n A-->B"] },
  { name: "nested in longer non-mermaid fence", markdown: "````text\n```mermaid\nflowchart TD\n A-->B\n```\n````", sources: [] },
  { name: "CRLF", markdown: "```mermaid\r\nflowchart TD\r\n A-->B\r\n```\r\n", sources: ["flowchart TD\n A-->B"] },
  { name: "empty", markdown: "```mermaid\n```", sources: [""] },
  {
    name: "several fences",
    markdown: "```js\nconst x = 1;\n```\n\n```mermaid\nflowchart TD\n```\n\n~~~mermaid\nflowchart LR\n~~~",
    sources: ["flowchart TD", "flowchart LR"],
  },
];

test.each(fenceCases)("the Mermaid scanner matches real Book code text: $name", ({ markdown, sources }) => {
  const dom = createDomTestHarness();
  try {
    dom.root.innerHTML = renderNotebookBook({ markdown, notebookId: "book01", noteId: "note01", locale: "en" }).html;
    const rendered = Array.from(dom.root.querySelectorAll("code.language-mermaid"), (code) => code.textContent);
    expect(rendered).toEqual(sources);
    expect(mermaidFenceSources(markdown)).toEqual(rendered);
  } finally {
    dom.cleanup();
  }
});
