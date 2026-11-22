import { describe, it, expect, beforeEach } from "bun:test";
import { readJsonCookie, writeJsonCookie, readCookie, writeCookie, deleteCookie } from "./cookies";

// Mock document.cookie
let cookieStore = "";
Object.defineProperty(globalThis, "document", {
  value: {
    get cookie() { return cookieStore; },
    set cookie(v: string) {
      // Simulate browser: parse name=value, store it
      const [nameValue] = v.split(";");
      const eqIdx = nameValue!.indexOf("=");
      const name = nameValue!.substring(0, eqIdx);
      const value = nameValue!.substring(eqIdx + 1);

      // Check for max-age=0 (delete)
      if (v.includes("max-age=0")) {
        const pairs = cookieStore.split("; ").filter(c => !c.startsWith(name + "="));
        cookieStore = pairs.join("; ");
        return;
      }

      // Update or add
      const pairs = cookieStore ? cookieStore.split("; ") : [];
      const idx = pairs.findIndex(c => c.startsWith(name + "="));
      const entry = `${name}=${value}`;
      if (idx >= 0) pairs[idx] = entry;
      else pairs.push(entry);
      cookieStore = pairs.join("; ");
    }
  },
  writable: true,
  configurable: true,
});

// Mock location.protocol for secure flag
Object.defineProperty(globalThis, "location", {
  value: { protocol: "https:" },
  writable: true,
  configurable: true,
});

beforeEach(() => { cookieStore = ""; });

describe("writeCookie + readCookie", () => {
  it("roundtrips a simple string value", () => {
    writeCookie("theme", "dark");
    expect(readCookie("theme")).toBe("dark");
  });

  it("roundtrips a value containing special characters", () => {
    writeCookie("msg", "hello world & goodbye!");
    expect(readCookie("msg")).toBe("hello world & goodbye!");
  });

  it("handles values with = signs correctly", () => {
    writeCookie("token", "abc=def=ghi");
    expect(readCookie("token")).toBe("abc=def=ghi");
  });
});

describe("writeJsonCookie + readJsonCookie", () => {
  it("roundtrips a plain object", () => {
    const data = { color: "blue", size: 42 };
    writeJsonCookie("prefs", data);
    expect(readJsonCookie("prefs", {})).toEqual(data);
  });

  it("roundtrips nested data", () => {
    const data = { user: { name: "Alice", roles: ["admin", "editor"] }, active: true };
    writeJsonCookie("session", data);
    expect(readJsonCookie("session", {})).toEqual(data);
  });

  it("roundtrips an array", () => {
    const data = [1, 2, 3];
    writeJsonCookie("nums", data);
    expect(readJsonCookie<number[]>("nums", [])).toEqual(data);
  });

  it("roundtrips a primitive", () => {
    writeJsonCookie("count", 99);
    expect(readJsonCookie("count", 0)).toBe(99);
  });
});

describe("readCookie", () => {
  it("returns null for a missing cookie", () => {
    expect(readCookie("nonexistent")).toBeNull();
  });
});

describe("readJsonCookie defaults and merging", () => {
  it("returns defaultValue for a missing cookie", () => {
    const def = { lang: "en", debug: false };
    expect(readJsonCookie("missing", def)).toEqual(def);
  });

  it("merges defaultValue with stored object (new fields preserved)", () => {
    const stored = { lang: "de" };
    writeJsonCookie("settings", stored);
    const def = { lang: "en", debug: false, version: 2 };
    // Stored overrides lang; debug and version come from default
    expect(readJsonCookie("settings", def)).toEqual({ lang: "de", debug: false, version: 2 });
  });

  it("does not merge when stored value is an array", () => {
    writeJsonCookie("arr", [1, 2]);
    expect(readJsonCookie("arr", [9])).toEqual([1, 2]);
  });

  it("does not merge when defaultValue is an array", () => {
    writeJsonCookie("obj", { a: 1 });
    expect(readJsonCookie<unknown>("obj", [9])).toEqual({ a: 1 });
  });
});

describe("deleteCookie", () => {
  it("removes an existing cookie", () => {
    writeCookie("temp", "value");
    expect(readCookie("temp")).toBe("value");
    deleteCookie("temp");
    expect(readCookie("temp")).toBeNull();
  });

  it("is a no-op for a nonexistent cookie", () => {
    deleteCookie("ghost");
    expect(readCookie("ghost")).toBeNull();
  });
});

describe("multiple cookies coexist", () => {
  it("reads the correct cookie among several", () => {
    writeCookie("a", "1");
    writeCookie("b", "2");
    writeCookie("c", "3");
    expect(readCookie("a")).toBe("1");
    expect(readCookie("b")).toBe("2");
    expect(readCookie("c")).toBe("3");
  });

  it("deleting one does not affect others", () => {
    writeCookie("x", "10");
    writeCookie("y", "20");
    deleteCookie("x");
    expect(readCookie("x")).toBeNull();
    expect(readCookie("y")).toBe("20");
  });

  it("updating one does not affect others", () => {
    writeCookie("p", "old");
    writeCookie("q", "keep");
    writeCookie("p", "new");
    expect(readCookie("p")).toBe("new");
    expect(readCookie("q")).toBe("keep");
  });
});

// ==========================
// Regression: name validation + malformed-decode safety
// ==========================

describe("cookies — defensive checks", () => {
  it("rejects cookie names containing reserved chars", () => {
    expect(() => writeCookie("a;b", "x")).toThrow();
    expect(() => writeCookie("a=b", "x")).toThrow();
    expect(() => writeCookie("a b", "x")).toThrow();
    expect(() => writeJsonCookie("a\nb", { x: 1 })).toThrow();
    expect(() => deleteCookie("a;b")).toThrow();
  });

  it("returns raw value when decodeURIComponent fails (third-party malformed cookie)", () => {
    // Inject directly via the cookie store (simulating a server-set cookie
    // whose value contains a stray %).
    document.cookie = "weird=%E0%A4%A%; path=/";
    expect(() => readCookie("weird")).not.toThrow();
    expect(readCookie("weird")).toBe("%E0%A4%A%");
  });
});
