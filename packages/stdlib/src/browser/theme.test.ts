import { describe, it, expect, beforeEach } from "bun:test";
import { theme, type ThemeMode } from "./theme";

// Mock document.documentElement.classList
let classList: Set<string>;

const fakeDocumentElement = {
  get classList() {
    return {
      contains: (cls: string) => classList.has(cls),
      add: (cls: string) => classList.add(cls),
      remove: (...cls: string[]) => cls.forEach((c) => classList.delete(c)),
    };
  },
};

Object.defineProperty(globalThis, "document", {
  value: { documentElement: fakeDocumentElement },
  writable: true,
  configurable: true,
});

// Mock cookies (writeCookie is called internally)
let lastCookie = "";
Object.defineProperty(globalThis, "location", {
  value: { protocol: "https:" },
  writable: true,
  configurable: true,
});

beforeEach(() => {
  classList = new Set<string>(["light"]);
  lastCookie = "";
});

describe("theme.getCurrent", () => {
  it("returns 'light' when no dark class present", () => {
    classList = new Set(["light"]);
    expect(theme.getCurrent()).toBe("light");
  });

  it("returns 'dark' when dark class is present", () => {
    classList = new Set(["dark"]);
    expect(theme.getCurrent()).toBe("dark");
  });

  it("returns 'light' when neither class present", () => {
    classList = new Set();
    expect(theme.getCurrent()).toBe("light");
  });
});

describe("theme.set", () => {
  it("applies dark mode class", () => {
    classList = new Set(["light"]);
    const result = theme.set("dark");
    expect(result).toBe("dark");
    expect(classList.has("dark")).toBe(true);
    expect(classList.has("light")).toBe(false);
  });

  it("applies light mode class", () => {
    classList = new Set(["dark"]);
    const result = theme.set("light");
    expect(result).toBe("light");
    expect(classList.has("light")).toBe(true);
    expect(classList.has("dark")).toBe(false);
  });

  it("removes both classes before adding new one", () => {
    classList = new Set(["dark", "light"]);
    theme.set("dark");
    expect(classList.has("light")).toBe(false);
    expect(classList.has("dark")).toBe(true);
  });
});

describe("theme.toggle", () => {
  it("toggles from light to dark", () => {
    classList = new Set(["light"]);
    const result = theme.toggle();
    expect(result).toBe("dark");
    expect(classList.has("dark")).toBe(true);
  });

  it("toggles from dark to light", () => {
    classList = new Set(["dark"]);
    const result = theme.toggle();
    expect(result).toBe("light");
    expect(classList.has("light")).toBe(true);
  });

  it("toggles back and forth", () => {
    classList = new Set(["light"]);
    expect(theme.toggle()).toBe("dark");
    expect(theme.toggle()).toBe("light");
    expect(theme.toggle()).toBe("dark");
  });
});
