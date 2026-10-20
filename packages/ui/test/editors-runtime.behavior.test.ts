import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type EditorKind = "autocomplete" | "markdown";
type Activation = "assistive-click" | "pointer-click" | "keyboard-enter" | "keyboard-tab";

const nextAnimationFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));

const installEditorDomSupport = (dom: DomTestHarness): void => {
  const prototype = dom.window.HTMLElement.prototype as unknown as {
    showPopover?: () => void;
    hidePopover?: () => void;
  };
  prototype.showPopover ??= () => undefined;
  prototype.hidePopover ??= () => undefined;

  Object.defineProperty(dom.document, "execCommand", {
    configurable: true,
    value: (command: string, _showUi: boolean, replacement: string): boolean => {
      if (command !== "insertText") return false;
      const activeElement = dom.document.activeElement;
      if (!(activeElement instanceof HTMLElement) || activeElement.tagName !== "TEXTAREA") return false;
      const textarea = activeElement as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
      const caret = start + replacement.length;
      textarea.setSelectionRange(caret, caret);
      const inputEvent = new Event("input", { bubbles: true });
      Object.defineProperty(inputEvent, "inputType", { value: "insertText" });
      textarea.dispatchEvent(inputEvent);
      return true;
    },
  });
};

const activateCompletion = async (dom: DomTestHarness, kind: EditorKind, activation: Activation): Promise<void> => {
  const editor =
    kind === "autocomplete"
      ? (await import("../src/inputs/AutocompleteEditor")).AutocompleteEditor
      : (await import("../src/inputs/markdown/MarkdownEditor")).MarkdownEditor;
  const changes: string[] = [];

  const dispose = render(() => {
    const [value, setValue] = createSignal("");
    return createComponent(editor, {
      label: "Assignee",
      value,
      onValueChange: (next: string) => {
        changes.push(next);
        setValue(next);
      },
      completions: [
        {
          trigger: "@",
          dropdown: true,
          suggest: () => [{ text: "@alice", appendSpace: false }],
        },
      ],
    });
  }, dom.root);

  const textarea = dom.root.querySelector("textarea");
  expect(textarea).not.toBeNull();
  textarea!.focus();
  textarea!.value = "@a";
  textarea!.setSelectionRange(2, 2);
  const inputEvent = new Event("input", { bubbles: true });
  Object.defineProperty(inputEvent, "inputType", { value: "insertText" });
  textarea!.dispatchEvent(inputEvent);
  await Promise.resolve();

  const option = dom.document.querySelector<HTMLElement>('[role="option"]');
  expect(option).not.toBeNull();
  expect(option!.textContent).toContain("alice");

  if (activation === "keyboard-enter" || activation === "keyboard-tab") {
    const keyboardEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: activation === "keyboard-enter" ? "Enter" : "Tab",
    });
    textarea!.dispatchEvent(keyboardEvent);
    expect(keyboardEvent.defaultPrevented).toBe(true);
  } else {
    if (activation === "pointer-click") {
      const mouseDownContinues = option!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(mouseDownContinues).toBe(false);
      expect(dom.document.activeElement).toBe(textarea);
    }
    option!.click();
  }

  expect(textarea!.value).toBe("@alice");
  expect(changes).toEqual(["@a", "@alice"]);
  expect(changes.filter((value) => value === "@alice")).toHaveLength(1);
  expect(dom.document.querySelector('[role="option"]')).toBeNull();
  expect(dom.document.activeElement).toBe(textarea);

  dispose();
};

describe("completion editor runtime behavior", () => {
  test("supports click, pointer, keyboard, focus, and toolbar contracts", async () => {
    const dom = createDomTestHarness();
    installEditorDomSupport(dom);

    const { AutocompleteEditor } = await import("../src/inputs/AutocompleteEditor");
    const [overlayValue, setOverlayValue] = createSignal("");
    const [overlayEnabled, setOverlayEnabled] = createSignal(true);
    const overlayChanges: string[] = [];
    let highlights = 0;
    const disposeOverlay = render(
      () =>
        createComponent(AutocompleteEditor, {
          label: "Query",
          value: overlayValue,
          get highlight() {
            return overlayEnabled()
              ? (text: string) => {
                  highlights += 1;
                  return text;
                }
              : undefined;
          },
          onValueChange: (next) => {
            overlayChanges.push(next);
            setOverlayValue(next);
          },
        }),
      dom.root,
    );
    await Promise.resolve();
    highlights = 0;
    const overlayTextarea = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    for (const next of ["a", "ab"]) {
      overlayTextarea.value = next;
      const input = new Event("input", { bubbles: true });
      Object.defineProperty(input, "inputType", { value: "insertText" });
      overlayTextarea.dispatchEvent(input);
    }
    expect(overlayChanges).toEqual(["a", "ab"]);
    expect(highlights).toBe(0);
    setOverlayEnabled(false);
    await nextAnimationFrame();
    expect(highlights).toBe(0);
    setOverlayEnabled(true);
    expect(highlights).toBe(0);
    await nextAnimationFrame();
    expect(highlights).toBe(1);
    disposeOverlay();

    for (const kind of ["autocomplete", "markdown"] as const) {
      await activateCompletion(dom, kind, "assistive-click");
      await activateCompletion(dom, kind, "pointer-click");
      await activateCompletion(dom, kind, "keyboard-enter");
      await activateCompletion(dom, kind, "keyboard-tab");
    }

    const { MarkdownEditor } = await import("../src/inputs/markdown/MarkdownEditor");

    const dispose = render(
      () =>
        createComponent(MarkdownEditor, {
          label: "Notes",
          value: "",
          onSave: () => undefined,
          saveDisabled: true,
        }),
      dom.root,
    );

    const tools = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-markdown-editor__tool"));
    const formattingTools = tools.filter((tool) => !tool.disabled);
    const disabledSave = tools.find((tool) => tool.disabled);
    expect(disabledSave?.getAttribute("aria-label")).toBe("Save");

    const lastFormattingTool = formattingTools.at(-1)!;
    lastFormattingTool.focus();
    lastFormattingTool.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }));

    expect(dom.document.activeElement).toBe(formattingTools[0]!);
    expect(dom.document.activeElement).not.toBe(disabledSave);

    dispose();

    let closes = 0;
    let saves = 0;
    const disposeDocument = render(
      () =>
        createComponent(MarkdownEditor, {
          value: "# Document",
          fill: true,
          variant: "embedded",
          disabled: true,
          onClose: () => {
            closes++;
          },
          onSave: () => {
            saves++;
          },
        }),
      dom.root,
    );
    const documentTools = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-markdown-editor__tool"));
    expect(documentTools.at(-1)!.getAttribute("aria-label")).toBe("Close");
    expect(documentTools.at(-2)!.getAttribute("aria-label")).toBe("Save");
    expect(documentTools.at(-1)!.disabled).toBe(false);
    expect(documentTools.at(-2)!.disabled).toBe(true);
    documentTools.at(-1)!.click();
    expect(closes).toBe(1);
    dom.root
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "s", ctrlKey: true }));
    expect(saves).toBe(0);
    expect(dom.root.querySelector('[data-variant="embedded"][data-fill="true"]')).not.toBeNull();
    disposeDocument();
    dom.cleanup();
  });
});

test("read-only autocomplete cancels suggestions and keeps selection, controlled updates and submit", async () => {
  const dom = createDomTestHarness();
  installEditorDomSupport(dom);
  const { AutocompleteEditor } = await import("../src/inputs/AutocompleteEditor");
  const [value, setValue] = createSignal("");
  const [readOnly, setReadOnly] = createSignal(false);
  let submitted = 0;
  let resolveSuggestion: ((value: readonly { text: string }[]) => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  const dispose = render(
    () =>
      createComponent(AutocompleteEditor, {
        value,
        get readOnly() {
          return readOnly();
        },
        onValueChange: setValue,
        onSubmit: () => {
          submitted++;
        },
        completions: [
          {
            trigger: "@",
            dropdown: true,
            suggest: (_query, _context, signal) => {
              requestSignal = signal;
              return new Promise<readonly { text: string }[]>((resolve) => {
                resolveSuggestion = resolve;
              });
            },
          },
        ],
      }),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    input.focus();
    input.value = "@a";
    input.setSelectionRange(2, 2);
    const edit = new Event("input", { bubbles: true });
    Object.defineProperty(edit, "inputType", { value: "insertText" });
    input.dispatchEvent(edit);
    expect(requestSignal).toBeDefined();
    setReadOnly(true);
    await Promise.resolve();
    expect(input.readOnly).toBeTrue();
    expect(requestSignal!.aborted).toBeTrue();
    resolveSuggestion!([{ text: "@alice" }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(dom.root.querySelector('[role="option"]')).toBeNull();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(value()).toBe("@a");
    input.setSelectionRange(0, 2);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(submitted).toBe(1);
    setValue("external update");
    await Promise.resolve();
    expect(input.value).toBe("external update");
    setReadOnly(false);
    await Promise.resolve();
    expect(input.readOnly).toBeFalse();
  } finally {
    dispose();
    dom.cleanup();
  }
});
