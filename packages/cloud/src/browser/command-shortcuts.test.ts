import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { collectContextAwareCommands, registerContextAwareCommand, requestContextCommandExecution } from "./command-bridge";
import { attachCommandShortcuts, contextCommandsWithShortcuts, shortcutLabel } from "./command-shortcuts";

const command = (id: string, shortcut: string) => ({ id, title: id, description: id, shortcut, action: () => {} });
const press = (target: EventTarget, key: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
};

test("shortcut collisions fail closed and recover after owner cleanup; duplicate IDs disappear", () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  const stopHost = attachCommandShortcuts((command) => calls.push(command.id));
  const first = registerContextAwareCommand(command("one", "ctrl+k"));
  const second = registerContextAwareCommand(command("two", "ctrl+k"));
  try {
    expect(contextCommandsWithShortcuts().every((command) => !command.shortcut)).toBe(true);
    expect(press(window, "k", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    second();
    expect(press(window, "k", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(calls).toEqual(["one"]);
    const duplicate = registerContextAwareCommand(command("one", "ctrl+j"));
    expect(collectContextAwareCommands()).toEqual([]);
    duplicate();
    expect(contextCommandsWithShortcuts()[0]?.shortcut).toBe("ctrl+k");
  } finally {
    first();
    second();
    stopHost();
    dom.cleanup();
  }
});

test("editing, dialogs, handled keys, repeats and composition do not trigger app actions", () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  const disposers = [
    attachCommandShortcuts((command) => calls.push(command.id)),
    registerContextAwareCommand(command("edit", "e")),
    registerContextAwareCommand(command("cloud.search", "ctrl+k")),
  ];
  try {
    const input = document.createElement("input");
    dom.root.append(input);
    press(input, "e");
    press(window, "e", { repeat: true });
    press(window, "e", { isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    input.dispatchEvent(handled);
    expect(calls).toEqual([]);
    const dialog = document.createElement("dialog");
    dialog.open = true;
    dom.root.append(dialog);
    press(window, "e");
    press(window, "k", { ctrlKey: true });
    expect(calls).toEqual(["cloud.search"]);
    dialog.remove();
    press(window, "e");
    expect(calls).toEqual(["cloud.search", "edit"]);
  } finally {
    disposers.reverse().forEach((stop) => stop());
    dom.cleanup();
  }
});

test("registered modified shortcuts run before conflicting editor bindings", () => {
  const dom = createDomTestHarness();
  let searches = 0;
  let editorCalls = 0;
  const stop = registerContextAwareCommand(command("notebooks.search", "ctrl+shift+k"));
  const stopHost = attachCommandShortcuts(() => searches++);
  try {
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    dom.root.append(editor);
    editor.addEventListener("keydown", () => editorCalls++);
    expect(press(editor, "K", { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(searches).toBe(1);
    expect(editorCalls).toBe(0);
    press(editor, "b", { ctrlKey: true });
    expect(editorCalls).toBe(1);
  } finally {
    stopHost();
    stop();
    dom.cleanup();
  }
});

test("AltGraph text input never becomes a Ctrl+Alt command", () => {
  const dom = createDomTestHarness();
  let calls = 0;
  const stop = registerContextAwareCommand(command("new-note", "ctrl+alt+n"));
  const stopHost = attachCommandShortcuts(() => calls++);
  try {
    const event = new KeyboardEvent("keydown", { key: "ń", code: "KeyN", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(event, "getModifierState", { value: (key: string) => key === "AltGraph" });
    window.dispatchEvent(event);
    expect(calls).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  } finally {
    stopHost();
    stop();
    dom.cleanup();
  }
});

test("Mac Option dead keys execute explicit modified letter shortcuts and display native modifiers", () => {
  const dom = createDomTestHarness();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  let calls = 0;
  const stop = registerContextAwareCommand(command("new", "mod+alt+n"));
  const stopHost = attachCommandShortcuts(() => calls++);
  try {
    press(window, "Dead", { code: "KeyN", metaKey: true, altKey: true });
    expect(calls).toBe(1);
    expect(shortcutLabel("mod+alt+n")).toBe("⌥⌘N");
    press(window, "n", { ctrlKey: true, altKey: true });
    expect(calls).toBe(1);
  } finally {
    stopHost();
    stop();
    dom.cleanup();
  }
});

test("both callback and link commands share a per-registration pending gate; unmount cancels queued execution", async () => {
  const dom = createDomTestHarness();
  try {
    for (const action of [() => {}, { command: "demo.compose", input: {} }]) {
      const stop = registerContextAwareCommand({ ...command("new", "c"), action });
      const current = collectContextAwareCommands()[0]!;
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let calls = 0;
      const run = async () => {
        calls++;
        await wait;
      };
      const first = requestContextCommandExecution(current, run);
      const second = requestContextCommandExecution(current, run);
      await Promise.resolve();
      expect(calls).toBe(1);
      finish();
      await Promise.all([first, second]);
      const queued = requestContextCommandExecution(current, run);
      stop();
      await expect(queued).rejects.toThrow("no longer available");
      expect(calls).toBe(1);
    }
  } finally {
    dom.cleanup();
  }
});

test("logical letter shortcuts respect QWERTZ layout", () => {
  const dom = createDomTestHarness();
  const calls: string[] = [];
  const stops = [
    registerContextAwareCommand(command("undo", "ctrl+z")),
    registerContextAwareCommand(command("redo", "ctrl+y")),
    attachCommandShortcuts((command) => calls.push(command.id)),
  ];
  try {
    press(window, "z", { code: "KeyY", ctrlKey: true });
    expect(calls).toEqual(["undo"]);
  } finally {
    stops.forEach((stop) => stop());
    dom.cleanup();
  }
});
