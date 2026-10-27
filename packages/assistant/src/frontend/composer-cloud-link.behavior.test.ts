import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { watchPastedLink } from "./composer-cloud-link";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  const input = (field: HTMLTextAreaElement, inputType: string) => field.dispatchEvent(Object.assign(new Event("input"), { inputType }));

  test("the paste's own input keeps the pasted link; typing, deleting, undo or a second paste end it", () => {
    const dom = createDomTestHarness();
    const field = document.createElement("textarea");
    dom.root.append(field);
    try {
      for (const next of ["insertText", "deleteContentBackward", "historyUndo", "insertFromPaste"]) {
        const watch = watchPastedLink(field);
        input(field, "insertFromPaste");
        expect(watch.edited()).toBe(false);
        input(field, next);
        expect(watch.edited()).toBe(true);
        watch.stop();
      }
      const stopped = watchPastedLink(field);
      stopped.stop();
      input(field, "insertFromPaste");
      input(field, "historyUndo");
      expect(stopped.edited()).toBe(false);
    } finally {
      dom.cleanup();
    }
  });
}
