import { afterEach, describe, expect, test } from "bun:test";
import { toggleCodeBlock, toggleHeading, toggleInlineMarker, toggleNumberedList } from "./actions";
import { computeActiveFormats } from "./active-formats";
import { handleListContinuation, handleShortcut, handleSmartPaste } from "./behaviors";
import { isInCodeZone } from "./code-zone";

type FakeTextarea = HTMLTextAreaElement & {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

let active: FakeTextarea | null = null;
const originalDocument = globalThis.document;

const textarea = (value: string, start = 0, end = start): FakeTextarea => {
  const element = {
    value,
    selectionStart: start,
    selectionEnd: end,
    focus() {
      active = element as unknown as FakeTextarea;
    },
    setSelectionRange(nextStart: number, nextEnd: number) {
      active = element as unknown as FakeTextarea;
      element.selectionStart = nextStart;
      element.selectionEnd = nextEnd;
    },
    dispatchEvent() {
      return true;
    },
  };
  return element as unknown as FakeTextarea;
};

afterEach(() => {
  active = null;
  globalThis.document = originalDocument;
});

const installExecCommand = (): void => {
  globalThis.document = {
    execCommand: (_command: string, _showUi: boolean, value: string) => {
      if (!active) return false;
      const start = active.selectionStart;
      active.value = active.value.slice(0, start) + value + active.value.slice(active.selectionEnd);
      active.selectionStart = start + value.length;
      active.selectionEnd = active.selectionStart;
      return true;
    },
  } as Document;
};

describe("markdown editor helpers", () => {
  test("toggles headings and numbered line selections through native insertion", () => {
    installExecCommand();
    const heading = textarea("Title", 2);
    toggleHeading(heading, 2);
    expect(heading.value).toBe("## Title");
    toggleHeading(heading, 2);
    expect(heading.value).toBe("Title");

    const list = textarea("alpha\nbeta", 0, "alpha\nbeta".length);
    toggleNumberedList(list);
    expect(list.value).toBe("1. alpha\n2. beta");
  });

  test("wraps lines in a code block and inline markers without placeholder text", () => {
    installExecCommand();
    const lines = textarea("a\nconst b = 1;", 2, 14);
    toggleCodeBlock(lines);
    expect(lines.value).toBe("a\n```\nconst b = 1;\n```");
    expect([lines.selectionStart, lines.selectionEnd]).toEqual([6, 18]);
    const fenced = textarea("```\nx\n```", 0, 9);
    toggleCodeBlock(fenced);
    expect(fenced.value).toBe("x");
    const empty = textarea("", 0);
    toggleCodeBlock(empty);
    expect(empty.value).toBe("```\n\n```");
    expect(empty.selectionStart).toBe(4);

    const caret = textarea("say ", 4);
    toggleInlineMarker(caret, "~~");
    expect(caret.value).toBe("say ~~~~");
    expect([caret.selectionStart, caret.selectionEnd]).toEqual([6, 6]);
  });

  test("continues and exits markdown lists", () => {
    installExecCommand();
    const item = textarea("- first", 7);
    expect(handleListContinuation(item)).toBe(true);
    expect(item.value).toBe("- first\n- ");

    const empty = textarea("- ", 2);
    expect(handleListContinuation(empty)).toBe(true);
    expect(empty.value).toBe("");
  });

  test("validates and escapes smart-pasted links", () => {
    installExecCommand();
    const element = textarea("Docs", 0, 4);
    const event = {
      clipboardData: {
        getData: () => "https://example.test/wiki/Foo_(bar)",
      },
    } as unknown as ClipboardEvent;
    expect(handleSmartPaste(event, element)).toBe(true);
    expect(element.value).toBe("[Docs](https://example.test/wiki/Foo_%28bar%29)");
  });

  test("runs formatting shortcuts and ignores non-shortcut modifiers", () => {
    installExecCommand();
    const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
      ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...init }) as KeyboardEvent;

    const bold = textarea("word", 0, 4);
    expect(handleShortcut(key({ key: "B", ctrlKey: true, metaKey: true }), bold)).toBe(true);
    expect(bold.value).toBe("**word**");

    // `event.code` drives block shortcuts so they stay layout-independent.
    const heading = textarea("Title", 5);
    expect(handleShortcut(key({ key: "!", code: "Digit1", ctrlKey: true, metaKey: true, shiftKey: true }), heading)).toBe(true);
    expect(heading.value).toBe("# Title");

    // AltGr (alt+ctrl) and IME composition must never hijack character entry.
    const untouched = textarea("word", 0, 4);
    expect(handleShortcut(key({ key: "b", ctrlKey: true, metaKey: true, altKey: true }), untouched)).toBe(false);
    expect(handleShortcut(key({ key: "b", ctrlKey: true, metaKey: true, isComposing: true }), untouched)).toBe(false);
    expect(handleShortcut(key({ key: "b" }), untouched)).toBe(false);
    expect(untouched.value).toBe("word");
  });

  test("treats Object.prototype member names as unbound keys", () => {
    installExecCommand();
    const element = textarea("word", 0, 4);
    // Shortcut tables are keyed by attacker-influenceable event fields; a
    // lookup that walked the prototype chain would throw inside the keydown
    // handler (or report a phantom shortcut) instead of falling through.
    for (const name of ["constructor", "__proto__", "valueOf", "toString", "hasOwnProperty"]) {
      const inline = { key: name, code: "", metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, isComposing: false };
      const block = { key: "", code: name, metaKey: true, ctrlKey: true, shiftKey: true, altKey: false, isComposing: false };
      expect(handleShortcut(inline as KeyboardEvent, element)).toBe(false);
      expect(handleShortcut(block as KeyboardEvent, element)).toBe(false);
    }
    expect(element.value).toBe("word");
  });

  test("detects active formats and suppressible code zones", () => {
    expect(computeActiveFormats(textarea("## **bold**", 6))).toEqual(new Set(["h2", "bold"]));
    expect(isInCodeZone("before `literal", 15)).toBe(true);
    expect(isInCodeZone("```\nliteral", 11)).toBe(true);
    expect(isInCodeZone("after `literal`", 15)).toBe(false);
  });
});
