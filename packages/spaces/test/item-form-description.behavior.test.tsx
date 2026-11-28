import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceColumn } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import { installV2Globals } from "./v2-dom";

// The description of a task or event is written in main's Markdown editor (v1's `TextInput markdown`): the full form
// shows its formatting toolbar, Enter in a list starts the next entry, and the formatting keys format.

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const columns: SpaceColumn[] = [
  { id: "22222222-2222-4222-8222-222222222222", spaceId: SPACE_ID, name: "Open", color: null, rank: "1024", isDone: false },
];

describe("Spaces item description", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("the full form writes the description in the Markdown editor with its toolbar, lists and formatting keys", async () => {
    const dom = createDomTestHarness();
    installV2Globals(dom);
    const { default: ItemForm } = await import("../src/frontend/[id]/_components/shared/ItemForm");
    const dispose = render(
      () =>
        createComponent(ItemForm, {
          spaceId: SPACE_ID,
          columns,
          tags: [],
          defaults: { type: "task", columnId: columns[0]!.id },
          onSubmit: () => undefined,
          onCancel: () => undefined,
        }),
      dom.root,
    );
    try {
      const field = dom.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]');
      expect(field).not.toBeNull();
      const editor = field!.closest(".k2b-markdown-editor");
      expect(editor?.querySelector('button[aria-label^="Bold"]')).not.toBeNull();

      const press = (key: string, modifiers: KeyboardEventInit = {}) => {
        const event = new dom.window.KeyboardEvent("keydown", {
          key,
          code: key === "Enter" ? "Enter" : `Key${key.toUpperCase()}`,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        });
        field!.dispatchEvent(event as unknown as Event);
        return event.defaultPrevented;
      };
      const write = (text: string, selection: [number, number] = [text.length, text.length]) => {
        field!.focus();
        field!.value = text;
        field!.setSelectionRange(...selection);
        field!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      };
      write("- pallets");
      expect(press("Enter")).toBe(true);
      expect(field!.value).toBe("- pallets\n- ");
      write("count shelf B", [0, 5]);
      expect(press("b", { ctrlKey: true, metaKey: navigator.platform.startsWith("Mac") })).toBe(true);
      expect(field!.value).toBe("**count** shelf B");
    } finally {
      dispose();
      // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
      await Bun.sleep(20);
      dom.cleanup();
    }
  });
});
