import { describe, expect, test } from "bun:test";
import { formatShortcut, keyboardPlatform } from "./shortcut";

const format = (keys: string, platform: "apple" | "other" = "other", locale = "en") => formatShortcut(keys, { platform, locale });

describe("shortcut formatting", () => {
  test("detects platforms from a platform string or User-Agent", () => {
    for (const source of ["MacIntel", "iPhone", "iPad", "iPod", "Mozilla Mac OS X"]) expect(keyboardPlatform(source)).toBe("apple");
    for (const source of ["", "Win32", "Linux x86_64"]) expect(keyboardPlatform(source)).toBe("other");
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Reflect.deleteProperty(globalThis, "navigator");
      expect(keyboardPlatform()).toBe("other");
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "", userAgent: "iPad" } });
      expect(keyboardPlatform()).toBe("apple");
      expect(formatShortcut("mod+k").label).toBe("⌘K");
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  test("inherits the document language and falls back to English on the server", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    try {
      Reflect.deleteProperty(globalThis, "document");
      expect(formatShortcut("ctrl+k", { platform: "other" }).label).toBe("Ctrl+K");
      Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { lang: "de" } } });
      expect(formatShortcut("ctrl+k", { platform: "other" }).label).toBe("Strg+K");
      expect(formatShortcut("ctrl+k", { platform: "other", locale: "en" }).label).toBe("Ctrl+K");
    } finally {
      if (previous) Object.defineProperty(globalThis, "document", previous);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("server helpers use the runtime navigator unless the request platform is supplied", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
      expect(keyboardPlatform()).toBe("apple");
      expect(formatShortcut("mod+k", { locale: "en" }).label).toBe("⌘K");
      const platform = keyboardPlatform("Mozilla/5.0 (Windows NT 10.0)");
      expect(platform).toBe("other");
      expect(formatShortcut("mod+k", { platform, locale: "en" }).label).toBe("Ctrl+K");
    } finally {
      if (previous) Object.defineProperty(globalThis, "navigator", previous);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  test("canonicalizes modifiers, duplicates, case and plus as a key", () => {
    expect(format("MeTa+SHIFT+alt+CTRL+k", "apple").label).toBe("⌃⌥⇧⌘K");
    expect(format("meta+shift+alt+ctrl+k").label).toBe("Ctrl+Alt+Shift+Meta+K");
    expect(format("mod+ctrl+ctrl+k").label).toBe("Ctrl+K");
    expect(format("mod+meta+k", "apple").label).toBe("⌘K");
    expect(format("mod+ctrl+k", "apple").label).toBe("⌃⌘K");
    expect(format("mod+alt+n", "apple").label).toBe("⌥⌘N");
    expect(format("alt+arrowup").label).toBe("Alt+↑");
    expect(format("shift+/").label).toBe("Shift+/");
    expect(format("mod++").label).toBe("Ctrl++");
    expect(format("mod++", "apple").label).toBe("⌘+");
    expect(format("+").keys).toEqual([{ label: "+", name: "+" }]);
    for (const input of ["", "  ", "\t", "ctrl+\t", "mod", "ctrl", "k+q", "unknown+k", "mod+", "mod+++", "ctrl++k"]) {
      expect(format(input), input).toEqual({ keys: [], label: "", name: "" });
    }
  });

  test("literal space keys use localized caps while normal shortcuts still trim surrounding whitespace", () => {
    for (const platform of ["apple", "other"] as const) {
      for (const input of ["ctrl+ ", " ", "mod+shift+ "]) {
        const named = input === " " ? "space" : `${input.slice(0, -1)}space`;
        expect(format(input, platform, "en")).toEqual(format(named, platform, "en"));
        expect(format(input, platform, "de")).toEqual(format(named, platform, "de"));
        expect(format(input, platform, "en").keys.at(-1)).toEqual({ label: "Space", name: "Space" });
        expect(format(input, platform, "de").keys.at(-1)).toEqual({ label: "Leertaste", name: "Leertaste" });
      }
      expect(format(" mod+k ", platform)).toEqual(format("mod+k", platform));
      expect(format(" + ", platform)).toEqual(format("+", platform));
      expect(format(" mod++ ", platform)).toEqual(format("mod++", platform));
    }
  });

  test.each([
    ["arrowup", "↑", "↑", "Up arrow", "Pfeil nach oben"],
    ["arrowdown", "↓", "↓", "Down arrow", "Pfeil nach unten"],
    ["arrowleft", "←", "←", "Left arrow", "Pfeil nach links"],
    ["arrowright", "→", "→", "Right arrow", "Pfeil nach rechts"],
    ["enter", "↵", "↵", "Enter", "Eingabetaste"],
    ["escape", "Esc", "Esc", "Escape", "Escape"],
    ["esc", "Esc", "Esc", "Escape", "Escape"],
    ["tab", "Tab", "Tab", "Tab", "Tabulatortaste"],
    ["space", "Space", "Leertaste", "Space", "Leertaste"],
    ["backspace", "⌫", "⌫", "Backspace", "Rücktaste"],
    ["delete", "Del", "Entf", "Delete", "Entfernen"],
    ["home", "Home", "Pos1", "Home", "Pos 1"],
    ["end", "End", "Ende", "End", "Ende"],
    ["pageup", "PgUp", "Bild↑", "Page up", "Bild auf"],
    ["pagedown", "PgDn", "Bild↓", "Page down", "Bild ab"],
  ])("names %s in both locales and platforms", (key, enLabel, deLabel, enName, deName) => {
    for (const platform of ["apple", "other"] as const) {
      expect(format(key, platform, "en").keys).toEqual([{ label: key === "delete" && platform === "apple" ? "⌦" : enLabel, name: enName }]);
      expect(format(key, platform, "de-DE").keys).toEqual([
        { label: key === "delete" && platform === "apple" ? "⌦" : deLabel, name: deName },
      ]);
    }
  });

  test("localizes modifier caps and spoken names", () => {
    expect(format("ctrl+alt+shift+meta+k", "apple", "en").name).toBe("Control Option Shift Command K");
    expect(format("ctrl+alt+shift+meta+k", "apple", "de").name).toBe("Control Wahltaste Umschalttaste Befehlstaste K");
    expect(format("ctrl+alt+shift+meta+k", "other", "en").name).toBe("Control Alt Shift Meta K");
    expect(format("ctrl+alt+shift+meta+k", "other", "de").name).toBe("Steuerung Alt Umschalttaste Meta K");
    expect(format("mod+shift+k", "other", "de").label).toBe("Strg+Umschalt+K");
    for (const key of ["k", "/", "]", "f1", "f12"]) expect(format(key).name).toBe(key.toUpperCase());
    for (const key of ["constructor", "__proto__"]) {
      expect(format(key).keys).toEqual([{ label: key[0]!.toUpperCase() + key.slice(1), name: key[0]!.toUpperCase() + key.slice(1) }]);
    }
    expect(format("capslock").keys).toEqual([{ label: "Capslock", name: "Capslock" }]);
  });
});
