import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { installV2Globals } from "./v2-dom";

// The comment composer of the open item on v2 is main's Markdown composer (v1's Discussion.Composer): Ctrl or Cmd with
// Enter sends, Enter and Shift with Enter start a new line, a list goes on with Enter, and the formatting keys format.

const posted: string[] = [];
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      ":id": {
        items: {
          ":itemId": {
            comments: {
              $post: async ({ json }: { json: { content: string } }) => {
                posted.push(json.content);
                return Response.json({ id: "Com009" });
              },
            },
          },
        },
      },
    },
  }));
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await Bun.sleep(10);
};

describe("Spaces comment composer", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  let dom: DomTestHarness;
  let dispose: () => void = () => undefined;
  let updates = 0;
  beforeEach(() => {
    dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    dom.root.className = "k2b-ui";
    installV2Globals(dom);
    delegateEvents(["click", "input", "keydown"], dom.document);
    posted.length = 0;
    updates = 0;
  });
  afterEach(() => {
    dispose();
    dom.cleanup();
  });

  const mount = async () => {
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: CommentsSection } = await import("../src/frontend/[id]/_components/detail/CommentsSection");
    dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(CommentsSection, {
              spaceId: "Space1",
              itemId: "Item01",
              recurrenceId: null,
              comments: [],
              total: 0,
              loading: false,
              hasMore: false,
              loadingMore: false,
              onLoadMore: () => undefined,
              onRetry: () => undefined,
              currentUserId: "33333333-3333-4333-8333-333333333333",
              onUpdate: () => void updates++,
              canWrite: true,
            });
          },
        }),
      dom.root,
    );
    // The field is named "Add comment", by its own name or by its label.
    const field = [...dom.root.querySelectorAll<HTMLTextAreaElement>("textarea")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === "Add comment" ||
        dom.root.querySelector(`label[for="${candidate.id}"]`)?.textContent?.trim().startsWith("Add comment"),
    );
    if (!field) throw new Error("No comment field named Add comment");
    return field;
  };
  /** Writes into the field as typing would, with the caret at the end. */
  const write = (field: HTMLTextAreaElement, text: string, selection?: [number, number]) => {
    field.focus();
    field.value = text;
    field.setSelectionRange(...(selection ?? [text.length, text.length]));
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** Presses a key in the field; true when the composer handled it instead of the browser. */
  const press = (field: HTMLTextAreaElement, key: string, modifiers: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", {
      key,
      code: key === "Enter" ? "Enter" : `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    field.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };

  test("Ctrl+Enter sends the comment and empties the field", async () => {
    const field = await mount();
    write(field, "Looks **good**");
    expect(press(field, "Enter", { ctrlKey: true })).toBe(true);
    await settle();
    expect(posted).toEqual(["Looks **good**"]);
    expect(updates).toBe(1);
    expect(field.value).toBe("");
  });

  test("Enter and Shift+Enter start a new line and send nothing; Enter in a list starts its next entry", async () => {
    const field = await mount();
    write(field, "First line");
    // The browser writes the new line: the composer leaves both keys to it.
    expect(press(field, "Enter")).toBe(false);
    expect(press(field, "Enter", { shiftKey: true })).toBe(false);
    write(field, "- milk");
    expect(press(field, "Enter")).toBe(true);
    expect(field.value).toBe("- milk\n- ");
    await settle();
    expect(posted).toEqual([]);
  });

  test("the formatting keys format the selected words, as on main", async () => {
    const field = await mount();
    write(field, "ship it", [0, 4]);
    // Ctrl here, Cmd on a Mac.
    expect(press(field, "b", { ctrlKey: true, metaKey: navigator.platform.startsWith("Mac") })).toBe(true);
    expect(field.value).toBe("**ship** it");
  });
});
