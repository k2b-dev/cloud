import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { watchPastedLink } from "./composer-cloud-link";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  const input = (field: HTMLTextAreaElement, type: "beforeinput" | "input", inputType: string) =>
    field.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { inputType }));
  const key = (init: { key: string; ctrlKey?: boolean; shiftKey?: boolean }) =>
    Object.assign(
      new Event("keydown", { bubbles: true, cancelable: true }),
      { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false },
      init,
    );
  const paste = (field: HTMLTextAreaElement) => {
    input(field, "beforeinput", "insertFromPaste");
    input(field, "input", "insertFromPaste");
  };

  test("the paste's own input keeps the pasted link; typing, deleting, undo or a second paste end it", () => {
    const dom = createDomTestHarness();
    const field = document.createElement("textarea");
    dom.root.append(field);
    try {
      for (const next of ["insertText", "deleteContentBackward", "historyUndo", "insertFromPaste"]) {
        const watch = watchPastedLink(field);
        paste(field);
        expect(watch.edited()).toBe(false);
        input(field, "beforeinput", next);
        expect(watch.edited()).toBe(true);
        watch.stop();
      }
      const stopped = watchPastedLink(field);
      stopped.stop();
      paste(field);
      input(field, "input", "historyUndo");
      expect(stopped.edited()).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test("the composer's own undo keys end the pasted link although they send no input", async () => {
    const dom = createDomTestHarness();
    const { Chat, LocaleProvider } = await import("@k2b/ui");
    const { createComponent, createSignal } = await import("solid-js");
    const { render } = await import("solid-js/web");
    const [value, setValue] = createSignal("https://cloud.example/app/spaces/Spc001?item=Itm001 today");
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(Chat.Composer, {
              get value() {
                return value();
              },
              onValueChange: setValue,
              onSubmit: () => true,
            });
          },
        }),
      dom.root,
    );
    try {
      const field = dom.root.querySelector("textarea");
      if (!field) throw new Error("Expected the composer's text field");
      const watch = watchPastedLink(field);
      paste(field);
      field.dispatchEvent(key({ key: "Shift", shiftKey: true }));
      expect(watch.edited()).toBe(false);
      field.dispatchEvent(key({ key: "z", ctrlKey: true }));
      expect(watch.edited()).toBe(true);
      watch.stop();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
