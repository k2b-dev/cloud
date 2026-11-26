import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const drop = (files: File[]) => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
};
const file = (name: string) => new File(["%PDF-1.7"], name, { type: "application/pdf" });

describe("Document to Markdown drops", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mount = async (props: { initialBusy?: boolean }) => {
    const dom = createDomTestHarness();
    const native = globalThis.fetch;
    // the conversion never answers, so the page stays converting
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const { LocaleProvider } = await import("@k2b/ui");
    const { DocumentMarkdownView } = await import("./DocumentMarkdown.island");
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(DocumentMarkdownView, props);
          },
        }),
      dom.root,
    );
    await settle();
    return {
      dom,
      text: () => dom.root.textContent ?? "",
      done: () => {
        dispose();
        globalThis.fetch = native;
        dom.cleanup();
      },
    };
  };

  test("a document dropped while another converts is refused out loud", async () => {
    const page = await mount({ initialBusy: true });
    try {
      drop([file("later.pdf")]);
      await settle();
      expect(page.text()).toContain("later.pdf was not converted");
      expect(page.text()).toContain("Cancel it to convert another document.");
    } finally {
      page.done();
    }
  });

  test("of several dropped documents the first converts and the page says the others did not", async () => {
    const page = await mount({});
    try {
      drop([file("first.pdf"), file("second.pdf"), file("third.pdf")]);
      await settle();
      expect(page.text()).toContain("Converting first.pdf");
      expect(page.text()).toContain("Only first.pdf is converted");
      expect(page.text()).toContain("2 more documents were not converted.");
      // a single document afterwards clears the note
      drop([file("fourth.pdf")]);
      await settle();
      expect(page.text()).not.toContain("Only first.pdf is converted");
    } finally {
      page.done();
    }
  });
});
