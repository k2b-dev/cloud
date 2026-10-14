import { describe, expect, test } from "bun:test";
import { ariaShortcut, shortcutLabel } from "./shortcut-label";

const en = "en";
const de = "de";

describe("shortcut labels", () => {
  test.each(["MacIntel", "iPhone", "iPad", "iPod", "Win32", "Linux x86_64"])("uses platform key names on %s", (platform) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform } });
    try {
      const apple = /Mac|iPhone|iPad|iPod/.test(platform);
      expect(shortcutLabel("Mod-Shift-2", en)).toBe(apple ? "⇧⌘2" : "Ctrl+Shift+2");
      expect(shortcutLabel("Mod-Alt-k", en)).toBe(apple ? "⌥⌘K" : "Ctrl+Alt+K");
      expect(shortcutLabel("Mod-]", en)).toBe(apple ? "⌘]" : "Ctrl+]");
      expect(shortcutLabel("Mod-b", de)).toBe(apple ? "⌘B" : "Strg+B");
      expect(shortcutLabel("Mod-Shift-h", de)).toBe(apple ? "⇧⌘H" : "Strg+Umschalt+H");
      expect(shortcutLabel("Mod-Shift-Alt-Ctrl-k", en)).toBe(apple ? "⌃⌥⇧⌘K" : "Ctrl+Alt+Shift+K");
      expect(shortcutLabel("Mod--", en)).toBe(apple ? "⌘-" : "Ctrl+-");
      expect(ariaShortcut("Mod-Shift-2")).toBe(apple ? "Meta+Shift+2" : "Control+Shift+2");
      expect(ariaShortcut("Mod-Alt-k")).toBe(apple ? "Meta+Alt+K" : "Control+Alt+K");
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});
