import { describe, expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { enhanceBookMermaid } from "./book-mermaid";

const figure =
  '<figure class="notebook-book-mermaid"><figcaption>Diagram source</figcaption><pre><code class="language-mermaid">flowchart TD\n A-->B</code></pre></figure>';

describe("Book Mermaid enhancement", () => {
  test("uses an image sink, retains source and revokes URLs on disposal", async () => {
    const dom = createDomTestHarness();
    const controller = new AbortController();
    try {
      dom.root.innerHTML = figure;
      await enhanceBookMermaid(
        dom.root,
        async () => '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        controller.signal,
        "Failed",
      );
      const image = dom.root.querySelector("img")!;
      expect(image.src).toStartWith("blob:");
      expect(dom.root.querySelector("svg")).toBeNull();
      expect(dom.root.querySelector("script")).toBeNull();
      image.dispatchEvent(new Event("load"));
      expect(dom.root.querySelector("details code")?.textContent).toContain("A-->B");
      controller.abort();
      expect(dom.root.querySelector("img")).toBeNull();
      expect(dom.root.querySelector("details")).toBeNull();
      expect(dom.root.querySelector("pre")?.textContent).toContain("A-->B");
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("a rejected diagram keeps readable source with localized feedback", async () => {
    const dom = createDomTestHarness();
    const controller = new AbortController();
    try {
      dom.root.innerHTML = figure;
      await enhanceBookMermaid(
        dom.root,
        async () => {
          throw new Error("parse error");
        },
        controller.signal,
        "Diagramm nicht verfügbar",
      );
      expect(dom.root.querySelector('[role="status"]')?.textContent).toBe("Diagramm nicht verfügbar");
      expect(dom.root.querySelector("pre")?.textContent).toContain("A-->B");
      expect(dom.root.querySelector("img")).toBeNull();
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("abort prevents late mutation and stops rendering subsequent diagrams", async () => {
    const dom = createDomTestHarness();
    const controller = new AbortController();
    let resolve!: (value: string) => void;
    let calls = 0;
    try {
      dom.root.innerHTML = figure + figure;
      const pending = enhanceBookMermaid(
        dom.root,
        () => {
          calls++;
          return new Promise<string>((done) => {
            resolve = done;
          });
        },
        controller.signal,
        "Failed",
      );
      controller.abort();
      resolve("<svg/>");
      await pending;
      expect(calls).toBe(1);
      expect(dom.root.querySelector("img")).toBeNull();
      expect(dom.root.querySelectorAll("pre").length).toBe(2);
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });

  test("empty roots do no rendering work", async () => {
    const dom = createDomTestHarness();
    const controller = new AbortController();
    let calls = 0;
    try {
      await enhanceBookMermaid(
        dom.root,
        async () => {
          calls++;
          return "<svg/>";
        },
        controller.signal,
        "Failed",
      );
      expect(calls).toBe(0);
    } finally {
      controller.abort();
      dom.cleanup();
    }
  });
});
