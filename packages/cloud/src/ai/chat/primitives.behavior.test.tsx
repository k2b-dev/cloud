import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

(isServer ? test.skip : test)("Markdown file links follow the current manifest, streaming text and ordinary click semantics", async () => {
  const dom = createDomTestHarness();
  const { AssistantMarkdownBlock } = await import("./primitives");
  const { AiChatActionsProvider } = await import("./message-actions");
  const html = '<a href="/report.md" target="_blank"><strong>Report</strong></a><a href="/app/grids/base">Base</a>';
  const [known, setKnown] = createSignal(false);
  const [content, setContent] = createSignal(html);
  const opened: string[] = [];
  const dispose = render(
    () => (
      <AiChatActionsProvider
        actions={{
          resolveFileLink: (href) => (known() && href === "/report.md" ? { path: href, href: "/app/assistant?workspace=file" } : null),
          onOpenFile: (path) => {
            opened.push(path);
          },
        }}
      >
        <AssistantMarkdownBlock html={content()} />
      </AiChatActionsProvider>
    ),
    dom.root,
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await tick();
    expect(dom.root.querySelector("a")!.getAttribute("href")).toBe("/report.md");
    setKnown(true);
    await tick();
    expect(dom.root.querySelector("a")!.getAttribute("href")).toBe("/app/assistant?workspace=file");
    expect(dom.root.querySelector("a")!.hasAttribute("target")).toBe(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    dom.root.querySelector("strong")!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual(["/report.md"]);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    dom.root.querySelector("a")!.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(1);
    expect(dom.root.querySelectorAll("a")[1]!.getAttribute("href")).toBe("/app/grids/base");
    setContent(`${html}<p>Streaming continuation</p>`);
    await tick();
    expect(dom.root.querySelector("a")!.getAttribute("href")).toBe("/app/assistant?workspace=file");
    const keyboardClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 });
    dom.root.querySelector("a")!.dispatchEvent(keyboardClick);
    expect(keyboardClick.defaultPrevented).toBe(true);
    expect(opened).toEqual(["/report.md", "/report.md"]);
    const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true });
    dom.root.querySelectorAll("a")[1]!.dispatchEvent(ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    const markdown = dom.root.querySelector(".assistant-markdown-block")!;
    expect(markdown.hasAttribute("role")).toBe(false);
    expect(markdown.hasAttribute("tabindex")).toBe(false);
    setKnown(false);
    await tick();
    expect(dom.root.querySelector("a")!.getAttribute("href")).toBe("/report.md");
    expect(dom.root.querySelector("a")!.getAttribute("target")).toBe("_blank");
    setKnown(true);
    await tick();
    const retainedLink = dom.root.querySelector("a")!;
    dispose();
    const afterDispose = new MouseEvent("click", { bubbles: true, cancelable: true });
    retainedLink.dispatchEvent(afterDispose);
    expect(afterDispose.defaultPrevented).toBe(false);
    expect(opened).toHaveLength(2);
  } finally {
    dispose();
    dom.cleanup();
  }
});
