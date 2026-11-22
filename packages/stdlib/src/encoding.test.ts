import { describe, it, expect } from "bun:test";
import {
  toBase64,
  fromBase64,
  fromBase64Strict,
  toHex,
  fromHex,
  toBase32,
  fromBase32,
  toBase62,
  fromBase62,
} from "./encoding";

// ==========================
// Base64
// ==========================

describe("toBase64 / fromBase64", () => {
  it("roundtrips empty Uint8Array", () => {
    const empty = new Uint8Array([]);
    expect(fromBase64(toBase64(empty))).toEqual(empty);
  });

  it("roundtrips ASCII text bytes", () => {
    const bytes = new TextEncoder().encode("Hello, World!");
    const result = fromBase64(toBase64(bytes));
    expect(result).toEqual(bytes);
  });

  it("roundtrips binary data with all byte values 0x00-0xFF", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const result = fromBase64(toBase64(bytes));
    expect(result).toEqual(bytes);
  });

  it("roundtrips large data (64KB) without stack overflow", () => {
    const bytes = new Uint8Array(65536);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const result = fromBase64(toBase64(bytes));
    expect(result).toEqual(bytes);
  });

  it("decodes a known base64 string", () => {
    const result = fromBase64("SGVsbG8=");
    expect(Array.from(result)).toEqual([72, 101, 108, 108, 111]);
  });
});

// ==========================
// Hex
// ==========================

describe("toHex / fromHex", () => {
  it("roundtrips empty Uint8Array", () => {
    const empty = new Uint8Array([]);
    expect(fromHex(toHex(empty))).toEqual(empty);
  });

  it("roundtrips known bytes", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const hex = toHex(bytes);
    expect(hex).toBe("deadbeef");
    expect(fromHex(hex)).toEqual(bytes);
  });

  it("produces lowercase hex", () => {
    expect(toHex(new Uint8Array([0xab]))).toBe("ab");
  });

  it("fromHex throws on odd-length string", () => {
    expect(() => fromHex("abc")).toThrow();
  });

  it("fromHex handles empty string", () => {
    expect(fromHex("")).toEqual(new Uint8Array([]));
  });

  it("fromHex throws on invalid hex characters", () => {
    expect(() => fromHex("gg")).toThrow();
  });
});

// ==========================
// Base32
// ==========================

describe("toBase32 / fromBase32", () => {
  it("roundtrips empty Uint8Array", () => {
    const empty = new Uint8Array([]);
    expect(fromBase32(toBase32(empty))).toEqual(empty);
  });

  it("roundtrips RFC 4648 test vector: 'f' -> 'MY======'", () => {
    const bytes = new TextEncoder().encode("f");
    expect(toBase32(bytes)).toBe("MY======");
    expect(fromBase32("MY======")).toEqual(bytes);
  });

  it("roundtrips RFC 4648 test vector: 'foobar' -> 'MZXW6YTBOI======'", () => {
    const bytes = new TextEncoder().encode("foobar");
    const b32 = toBase32(bytes);
    expect(b32).toBe("MZXW6YTBOI======");
    expect(fromBase32(b32)).toEqual(bytes);
  });

  it("fromBase32 is case-insensitive", () => {
    const upper = fromBase32("MY======");
    const lower = fromBase32("my======");
    expect(upper).toEqual(lower);
  });

  it("fromBase32 strips padding before decoding", () => {
    const withPad = fromBase32("MZXW6YTBOI======");
    const withoutPad = fromBase32("MZXW6YTBOI");
    expect(withPad).toEqual(withoutPad);
  });

  it("roundtrips binary data with all byte values", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const result = fromBase32(toBase32(bytes));
    expect(result).toEqual(bytes);
  });
});

// ==========================
// Base62
// ==========================

describe("toBase62 / fromBase62", () => {
  it("encodes 0", () => expect(toBase62(0)).toBe("0"));
  it("encodes small numbers", () => expect(toBase62(61)).toBe("z"));
  it("encodes 62", () => expect(toBase62(62)).toBe("10"));
  it("roundtrips", () => {
    for (const n of [0, 1, 42, 999, 123456789, Number.MAX_SAFE_INTEGER]) {
      expect(fromBase62(toBase62(n))).toBe(n);
    }
  });
  it("pads to minLength", () => expect(toBase62(1, 5)).toBe("00001"));
  it("throws on negative", () => expect(() => toBase62(-1)).toThrow());
  it("throws on invalid char", () => expect(() => fromBase62("!!!")).toThrow());
});

// ==========================
// fromBase64Strict — opt-in validation
// ==========================

describe("fromBase64Strict", () => {
  it("decodes valid Base64 like fromBase64", () => {
    expect(fromBase64Strict("SGVsbG8=")).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it("decodes URL-safe alphabet", () => {
    expect(fromBase64Strict("U2hlbGw_dGV4dA==")).toEqual(new Uint8Array([0x53, 0x68, 0x65, 0x6c, 0x6c, 0x3f, 0x74, 0x65, 0x78, 0x74]));
  });

  it("throws TypeError on invalid characters", () => {
    expect(() => fromBase64Strict("SGVsbG8=!!!")).toThrow(TypeError);
    expect(() => fromBase64Strict("SGVsbG8 ")).toThrow(TypeError);
    expect(() => fromBase64Strict("hello world!")).toThrow(TypeError);
  });

  it("throws on wrong length (not multiple of 4)", () => {
    expect(() => fromBase64Strict("abc")).toThrow(TypeError);
    expect(() => fromBase64Strict("abcde")).toThrow(TypeError);
  });

  it("rejects garbage that lenient fromBase64 accepts in Bun/Node", () => {
    // The lenient path silently decodes "SGVsbG8=!!!" to "Hello"; the strict
    // variant matches the browser atob behavior of rejection.
    expect(() => fromBase64Strict("SGVsbG8=!!!")).toThrow();
  });
});
