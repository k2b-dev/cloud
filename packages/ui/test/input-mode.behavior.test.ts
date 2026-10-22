import { describe, expect, spyOn, test } from "bun:test";
import { installInputModeController } from "../src/input-mode";
import { createDomTestHarness } from "./dom";

const setup = () => {
  const dom = createDomTestHarness();
  const html = dom.document.documentElement;
  const dispose = installInputModeController();
  const pointer = (type: string, pointerType: string) => {
    const event = new dom.window.Event(type, { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    dom.window.document.dispatchEvent(event);
  };
  const key = (target: Element = dom.document.body, init: KeyboardEventInit = { key: "a" }, altGraph = false) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, composed: true, ...init });
    if (altGraph) Object.defineProperty(event, "getModifierState", { value: (modifier: string) => modifier === "AltGraph" });
    target.dispatchEvent(event);
  };
  return {
    ...dom,
    html,
    dispose,
    pointer,
    key,
    cleanup: () => {
      dispose();
      dom.cleanup();
    },
  };
};

describe("input mode controller", () => {
  test("does nothing on the server", () => {
    expect(typeof document).toBe("undefined");
    expect(installInputModeController()).toBeFunction();
  });

  test("starts without attributes, follows pointer types, and retains the keyboard flag", () => {
    const dom = setup();
    const writes = spyOn(dom.html, "setAttribute");
    try {
      expect(dom.html.hasAttribute("data-k2b-input")).toBe(false);
      expect(dom.html.hasAttribute("data-k2b-kbd")).toBe(false);
      dom.pointer("pointerdown", "touch");
      expect(dom.html.getAttribute("data-k2b-input")).toBe("touch");
      dom.pointer("pointermove", "touch");
      expect(writes).toHaveBeenCalledTimes(1);
      dom.pointer("pointermove", "mouse");
      expect(dom.html.getAttribute("data-k2b-input")).toBe("trackpad");
      dom.key();
      expect(dom.html.getAttribute("data-k2b-kbd")).toBe("on");
      dom.pointer("pointerdown", "pen");
      expect(dom.html.getAttribute("data-k2b-input")).toBe("touch");
      expect(dom.html.getAttribute("data-k2b-kbd")).toBe("on");
      dom.pointer("pointermove", "");
      dom.pointer("pointerdown", "unknown");
      dom.pointer("mousemove", "mouse");
      expect(dom.html.getAttribute("data-k2b-input")).toBe("touch");
    } finally {
      writes.mockRestore();
      dom.cleanup();
    }
  });

  for (const key of [
    "",
    "Shift",
    "Control",
    "Alt",
    "AltGraph",
    "Meta",
    "OS",
    "Super",
    "Hyper",
    "Fn",
    "FnLock",
    "CapsLock",
    "NumLock",
    "ScrollLock",
    "Symbol",
    "SymbolLock",
    "Unidentified",
    "Process",
    "Dead",
  ]) {
    test(`ignores ${key}`, () => {
      const dom = setup();
      try {
        dom.key(undefined, { key });
        expect(dom.html.hasAttribute("data-k2b-kbd")).toBe(false);
      } finally {
        dom.cleanup();
      }
    });
  }

  test("ignores composition", () => {
    const dom = setup();
    try {
      dom.key(undefined, { key: "a", isComposing: true });
      expect(dom.html.hasAttribute("data-k2b-kbd")).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  for (const markup of [
    "<input>",
    "<textarea></textarea>",
    '<div contenteditable="true"></div>',
    '<input type="email">',
    '<input type="password">',
  ]) {
    test(`ignores typing and AltGraph in ${markup}`, () => {
      const dom = setup();
      try {
        dom.root.innerHTML = markup;
        const field = dom.root.firstElementChild!;
        dom.key(field);
        dom.key(field, { key: "q", ctrlKey: true, altKey: true }, true);
        expect(dom.html.hasAttribute("data-k2b-kbd")).toBe(false);
      } finally {
        dom.cleanup();
      }
    });
  }

  for (const init of [{ key: "k", ctrlKey: true }, { key: "k", metaKey: true }, { key: "Tab" }]) {
    test(`counts navigation or shortcuts in an input: ${JSON.stringify(init)}`, () => {
      const dom = setup();
      try {
        const input = dom.document.createElement("input");
        dom.root.append(input);
        dom.key(input, init);
        expect(dom.html.getAttribute("data-k2b-kbd")).toBe("on");
      } finally {
        dom.cleanup();
      }
    });
  }

  test("counts Space on a checkbox", () => {
    const dom = setup();
    try {
      dom.root.innerHTML = '<input type="checkbox">';
      dom.key(dom.root.firstElementChild!, { key: " " });
      expect(dom.html.getAttribute("data-k2b-kbd")).toBe("on");
    } finally {
      dom.cleanup();
    }
  });

  test("uses the original shadow target instead of its retargeted host", () => {
    const dom = setup();
    try {
      const host = dom.document.createElement("div");
      dom.root.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const input = dom.document.createElement("input");
      shadow.append(input);
      dom.key(input);
      expect(dom.html.hasAttribute("data-k2b-kbd")).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  test("multiple installs share attributes and each disposer removes its listeners", () => {
    const dom = setup();
    const second = installInputModeController(dom.document);
    try {
      dom.pointer("pointerdown", "touch");
      dom.dispose();
      dom.pointer("pointermove", "mouse");
      expect(dom.html.getAttribute("data-k2b-input")).toBe("trackpad");
      second();
      dom.pointer("pointerdown", "touch");
      dom.key();
      expect(dom.html.getAttribute("data-k2b-input")).toBe("trackpad");
      expect(dom.html.hasAttribute("data-k2b-kbd")).toBe(false);
    } finally {
      second();
      dom.cleanup();
    }
  });
});
