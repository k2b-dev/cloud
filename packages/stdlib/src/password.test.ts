import { describe, it, expect } from "bun:test";
import { PASSWORD_WORDS } from "./_password-words";
import { password } from "./password";

// ==========================
// password.random
// ==========================

describe("password.random", () => {
  it("generates 20-char password by default", () => {
    expect(password.random().length).toBe(20);
  });

  it("contains lowercase, uppercase, and digits by default", () => {
    const pw = password.random();
    expect(/[a-z]/.test(pw)).toBe(true);
    expect(/[A-Z]/.test(pw)).toBe(true);
    expect(/[0-9]/.test(pw)).toBe(true);
  });

  it("includes symbols when requested", () => {
    expect(/[!@#$%^&*()\-_=+\[\]{}<>?]/.test(password.random({ symbols: true }))).toBe(true);
  });

  it("respects custom length", () => {
    expect(password.random({ length: 8 }).length).toBe(8);
  });

  it("clamps length to minimum 4", () => {
    expect(password.random({ length: 1 }).length).toBe(4);
  });

  it("clamps length to maximum 64", () => {
    expect(password.random({ length: 100 }).length).toBe(64);
  });

  it("falls back to default length for non-finite values", () => {
    expect(password.random({ length: Number.NaN }).length).toBe(20);
    expect(password.random({ length: Number.POSITIVE_INFINITY }).length).toBe(20);
  });

  it("excludes uppercase when disabled", () => {
    const pw = password.random({ uppercase: false, numbers: false, length: 30 });
    expect(/^[a-z]+$/.test(pw)).toBe(true);
  });
});

// ==========================
// password.memorable
// ==========================

describe("password.memorable", () => {
  it("uses unique separator-safe dictionary words", () => {
    expect(PASSWORD_WORDS).toHaveLength(1296);
    expect(PASSWORD_WORDS.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    expect(new Set(PASSWORD_WORDS).size).toBe(PASSWORD_WORDS.length);
  });

  it("generates 4 hyphen-separated words by default", () => {
    const parts = password.memorable().split("-");
    expect(parts.length).toBe(4);
  });

  it("respects custom word count", () => {
    expect(password.memorable({ words: 6 }).split("-").length).toBe(6);
  });

  it("clamps word count to minimum 3", () => {
    expect(password.memorable({ words: 1 }).split("-").length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to default word count for non-finite values", () => {
    expect(password.memorable({ words: Number.NaN }).split("-").length).toBe(4);
    expect(password.memorable({ words: Number.POSITIVE_INFINITY }).split("-").length).toBe(4);
  });

  it("uses custom separator", () => {
    const pw = password.memorable({ separator: "." });
    expect(pw).toContain(".");
    expect(pw).not.toContain("-");
  });

  it("capitalizes words when requested", () => {
    const parts = password.memorable({ capitalize: true }).split("-");
    for (const part of parts) {
      // Skip number/symbol parts
      if (part.length > 1) {
        expect(part[0]).toBe(part[0]!.toUpperCase());
      }
    }
  });

  it("adds a number segment when addNumber is true", () => {
    const pw = password.memorable({ addNumber: true });
    const parts = pw.split("-");
    const hasDigitPart = parts.some((p) => /^\d+$/.test(p));
    expect(hasDigitPart).toBe(true);
  });

  it("adds a symbol segment when addSymbol is true", () => {
    const pw = password.memorable({ addSymbol: true });
    const parts = pw.split("-");
    const hasSymbolPart = parts.some((p) => /^[._+!]$/.test(p));
    expect(hasSymbolPart).toBe(true);
  });

  it("truncates words when fullWords is false", () => {
    const pw = password.memorable({ fullWords: false });
    const parts = pw.split("-");
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(5);
    }
  });
});

// ==========================
// password.pin
// ==========================

describe("password.pin", () => {
  it("generates 6-digit pin by default", () => {
    const pin = password.pin();
    expect(pin.length).toBe(6);
    expect(/^\d+$/.test(pin)).toBe(true);
  });

  it("respects custom length", () => {
    expect(password.pin({ length: 4 }).length).toBe(4);
  });

  it("clamps to 3-12", () => {
    expect(password.pin({ length: 1 }).length).toBe(3);
    expect(password.pin({ length: 20 }).length).toBe(12);
  });

  it("falls back to default length for non-finite values", () => {
    expect(password.pin({ length: Number.NaN }).length).toBe(6);
    expect(password.pin({ length: Number.POSITIVE_INFINITY }).length).toBe(6);
  });

  it("contains only digits", () => {
    expect(/^\d+$/.test(password.pin())).toBe(true);
  });
});

// ==========================
// password.strength
// ==========================

describe("password.strength", () => {
  it("scores empty password as very weak", () => {
    const s = password.strength("");
    expect(s.score).toBe(0);
    expect(s.label).toBe("very weak");
  });

  it("scores '123456' as very weak", () => {
    const s = password.strength("123456");
    expect(s.score).toBe(0);
  });

  it("scores 'password' as very weak", () => {
    const s = password.strength("password");
    expect(s.score).toBeLessThanOrEqual(1);
  });

  it("scores a strong random password highly", () => {
    const pw = password.random({ length: 24, symbols: true });
    const s = password.strength(pw);
    expect(s.score).toBeGreaterThanOrEqual(3);
    expect(s.entropy).toBeGreaterThan(80);
  });

  it("gives feedback for weak passwords", () => {
    const s = password.strength("abc");
    expect(s.feedback.length).toBeGreaterThan(0);
  });

  it("gives no feedback for strong passwords", () => {
    const pw = password.random({ length: 24, symbols: true });
    const s = password.strength(pw);
    expect(s.feedback.length).toBe(0);
  });

  it("detects missing character classes", () => {
    const s = password.strength("abcdefghij");
    expect(s.feedback.some(f => f.includes("uppercase"))).toBe(true);
    expect(s.feedback.some(f => f.includes("number"))).toBe(true);
  });

  it("detects sequential patterns", () => {
    const s = password.strength("abcdef123456");
    expect(s.feedback.some(f => f.includes("sequential"))).toBe(true);
  });

  it("detects repeated characters", () => {
    const s = password.strength("aaaaaaBBBBBB");
    expect(s.feedback.some(f => f.includes("repeated"))).toBe(true);
  });

  it("returns human-readable crack time", () => {
    const s = password.strength("Tr0ub4dor&3");
    expect(typeof s.crackTime).toBe("string");
    expect(s.crackTime.length).toBeGreaterThan(0);
  });

  it("scores memorable passwords appropriately", () => {
    const pw = password.memorable({ words: 6 });
    const s = password.strength(pw);
    expect(s.score).toBeGreaterThanOrEqual(2);
  });

  it("estimates separator-delimited passphrases as word choices", () => {
    const s = password.strength("correct-horse-battery-staple");
    expect(s.entropy).toBeCloseTo(41.36, 2);
    expect(s.score).toBe(2);
    expect(s.crackTime).toBe("5 minutes");
    expect(s.feedback).toContain("Use more random words");
  });

  // Regressions: tighten penalties for very-long-run sequences/repeats.
  it("does not score 50-char single-character runs as very strong", () => {
    const s = password.strength("a".repeat(48) + "A1!");
    // Was 'very strong' (4) before fix. Should now be < 4.
    expect(s.score).toBeLessThan(4);
    expect(s.feedback.length).toBeGreaterThan(0);
  });

  it("does not score full-alphabet sequences as very strong", () => {
    const s = password.strength("abcdefghijklmnopqrstuvwxyz123!");
    expect(s.score).toBeLessThan(4);
  });
});
