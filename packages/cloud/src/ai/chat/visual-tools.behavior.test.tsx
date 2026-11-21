import { afterAll, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

let dom: ReturnType<typeof createDomTestHarness> | undefined;
afterAll(() => dom?.cleanup());

if (isServer) test.skip("requires browser conditions and DOM transform", () => {});
else
  test("a text being sent says so in the reader's language", async () => {
    dom ??= createDomTestHarness();
    const { CloudTextEditorBlock } = await import("./visual-tools");
    const { LocaleProvider } = await import("@k2b/ui");
    let release = () => {};
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(CloudTextEditorBlock, {
              args: { title: "Antwort an Weber", content: "Guten Tag", submitLabel: "Weiter" },
              onSubmit: () => new Promise<void>((resolve) => (release = resolve)),
            });
          },
        }),
      dom.root,
    );
    try {
      const submit = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Weiter"))!;
      submit.click();
      await Promise.resolve();
      expect(submit.getAttribute("aria-label")).toBe("Wird gesendet");
    } finally {
      release();
      dispose();
    }
  });
