import { describe, it, expect } from "bun:test";
import {
  slugify,
  humanize,
  titleify,
  pprintNumber,
  pprintPercent,
  pprintDurationMs,
  pprintBytes,
  pprintBytesParts,
  pprintCurrency,
  truncate,
  summarize,
  camelCase,
  snakeCase,
  kebabCase,
  pascalCase,
  text,
} from "./text";

// ==========================
// slugify
// ==========================

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips diacritics via NFKD normalization", () => {
    expect(slugify("caf\u00e9")).toBe("cafe");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("collapses multiple non-alphanum chars into single hyphen", () => {
    expect(slugify("a!!!b")).toBe("a-b");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles string with only special characters", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("handles German umlauts", () => {
    expect(slugify("\u00dcberpr\u00fcfung")).toBe("uberprufung");
  });
});

// ==========================
// humanize
// ==========================

describe("humanize", () => {
  it("replaces underscores and hyphens with spaces, capitalizes first letter", () => {
    expect(humanize("hello_world")).toBe("Hello world");
  });

  it("replaces hyphens with spaces", () => {
    expect(humanize("hello-world-foo")).toBe("Hello world foo");
  });

  it("trims leading/trailing underscores and spaces", () => {
    expect(humanize("__hello__")).toBe("Hello");
  });

  it("handles empty string", () => {
    expect(humanize("")).toBe("");
  });
});

// ==========================
// titleify
// ==========================

describe("titleify", () => {
  it("capitalizes first letter of each word", () => {
    expect(titleify("hello world foo")).toBe("Hello World Foo");
  });

  it("works on hyphenated input", () => {
    expect(titleify("hello-world")).toBe("Hello World");
  });

  it("works on underscored input", () => {
    expect(titleify("hello_world")).toBe("Hello World");
  });
});

// ==========================
// pprintBytes
// ==========================

describe("pprintBytes", () => {
  it("returns '0 B' for zero", () => {
    expect(pprintBytes(0)).toBe("0 B");
  });

  it("returns raw bytes without decimals", () => {
    expect(pprintBytes(512)).toBe("512 B");
    expect(pprintBytes(1023)).toBe("1023 B");
  });

  it("defaults to IEC (1024-base) with KiB/MiB/GiB/TiB/PiB labels", () => {
    expect(pprintBytes(1024)).toBe("1 KiB");
    expect(pprintBytes(1536)).toBe("1.5 KiB");
    expect(pprintBytes(1024 ** 2)).toBe("1 MiB");
    expect(pprintBytes(1024 ** 3)).toBe("1 GiB");
    expect(pprintBytes(1024 ** 4)).toBe("1 TiB");
    expect(pprintBytes(1024 ** 5)).toBe("1 PiB");
  });

  it("uses SI (1000-base) with KB/MB/GB/TB/PB labels in si mode", () => {
    expect(pprintBytes(1000, { mode: "si" })).toBe("1 KB");
    expect(pprintBytes(1500, { mode: "si" })).toBe("1.5 KB");
    expect(pprintBytes(1_000_000, { mode: "si" })).toBe("1 MB");
    expect(pprintBytes(1_000_000_000, { mode: "si" })).toBe("1 GB");
    expect(pprintBytes(1e12, { mode: "si" })).toBe("1 TB");
    expect(pprintBytes(1e15, { mode: "si" })).toBe("1 PB");
  });

  it("scales decimals by magnitude (2 / 1 / 0)", () => {
    expect(pprintBytes(1024 + 512)).toBe("1.5 KiB"); // < 10 -> 1-2 dec
    expect(pprintBytes(15 * 1024)).toBe("15 KiB"); // >= 10 -> 1 dec, .0 trimmed
    expect(pprintBytes(15.5 * 1024)).toBe("15.5 KiB");
    expect(pprintBytes(123 * 1024 * 1024)).toBe("123 MiB"); // >= 100 -> 0 dec
  });

  it("caps at the largest unit instead of overflowing", () => {
    // 2048 PiB still rendered in PiB
    expect(pprintBytes(2 * 1024 ** 5)).toBe("2 PiB");
  });

  it("returns '0 B' for negative, NaN, and Infinity", () => {
    expect(pprintBytes(-100)).toBe("0 B");
    expect(pprintBytes(Number.NaN)).toBe("0 B");
    expect(pprintBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

// ==========================
// pprintBytesParts
// ==========================

describe("pprintBytesParts", () => {
  it("splits value and unit", () => {
    expect(pprintBytesParts(1536)).toEqual({ value: "1.5", unit: "KiB" });
    expect(pprintBytesParts(1500, { mode: "si" })).toEqual({ value: "1.5", unit: "KB" });
  });

  it("returns { '0', 'B' } for invalid input", () => {
    expect(pprintBytesParts(0)).toEqual({ value: "0", unit: "B" });
    expect(pprintBytesParts(-1)).toEqual({ value: "0", unit: "B" });
    expect(pprintBytesParts(Number.NaN)).toEqual({ value: "0", unit: "B" });
  });

  it("formats raw bytes without decimals", () => {
    expect(pprintBytesParts(512)).toEqual({ value: "512", unit: "B" });
  });

  it("localizes the numeric part via the locale option", () => {
    expect(pprintBytesParts(1536, { locale: "de" })).toEqual({ value: "1,5", unit: "KiB" });
    expect(pprintBytes(1536, { locale: "de" })).toBe("1,5 KiB");
    expect(pprintBytes(1500, { mode: "si", locale: "en-US" })).toBe("1.5 KB");
  });
});

// ==========================
// pprintCurrency
// ==========================

describe("pprintCurrency", () => {
  it("formats with locale and currency conventions", () => {
    // Intl uses a non-breaking space between amount and symbol.
    expect(pprintCurrency(1234.5, "EUR", { locale: "de" })).toBe("1.234,50 €");
    expect(pprintCurrency(1234.5, "USD", { locale: "en-US" })).toBe("$1,234.50");
  });

  it("respects explicit decimals", () => {
    expect(pprintCurrency(1234.5, "EUR", { locale: "en-US", decimals: 0 })).toBe("€1,235");
  });

  it("uses the currency's default fraction digits", () => {
    expect(pprintCurrency(1234.5, "JPY", { locale: "en-US" })).toBe("¥1,235");
  });

  it("returns the fallback for invalid input", () => {
    expect(pprintCurrency(null, "EUR")).toBe("—");
    expect(pprintCurrency(Number.NaN, "EUR")).toBe("—");
    expect(pprintCurrency(undefined, "EUR", { fallback: "n/a" })).toBe("n/a");
  });

  it("normalizes negative zero", () => {
    expect(pprintCurrency(-0, "USD", { locale: "en-US" })).toBe("$0.00");
  });
});

// ==========================
// pprintNumber
// ==========================

describe("pprintNumber", () => {
  it("uses locale-aware grouping", () => {
    expect(pprintNumber(1_234_567, { locale: "en-US" })).toBe("1,234,567");
    expect(pprintNumber(1_234_567, { locale: "de-DE" })).toBe("1.234.567");
  });

  it("uses fixed decimals when requested", () => {
    expect(pprintNumber(42.567, { decimals: 1, locale: "en-US" })).toBe("42.6");
    expect(pprintNumber(42, { decimals: 2, locale: "en-US" })).toBe("42.00");
  });

  it("uses deterministic compact units with localized decimals", () => {
    expect(pprintNumber(1_234, { compact: true, locale: "en-US" })).toBe("1.2k");
    expect(pprintNumber(1_234, { compact: true, locale: "de-DE" })).toBe("1,2k");
    expect(pprintNumber(1_234_567, { compact: true, locale: "en-US" })).toBe("1.2M");
    expect(pprintNumber(1_234_567_890, { compact: true, locale: "en-US" })).toBe("1.2B");
    expect(pprintNumber(1_234_567_890_000, { compact: true, locale: "en-US" })).toBe("1.2T");
  });

  it("preserves signs and promotes rounded compact boundaries", () => {
    expect(pprintNumber(-1_234, { compact: true, locale: "en-US" })).toBe("-1.2k");
    expect(pprintNumber(999_999, { compact: true, locale: "en-US" })).toBe("1M");
  });

  it("normalizes explicit decimal counts", () => {
    expect(pprintNumber(42.6, { decimals: -2, locale: "en-US" })).toBe("43");
    expect(pprintNumber(42, { decimals: 1.9, locale: "en-US" })).toBe("42.0");
  });

  it("returns the configurable fallback for invalid values", () => {
    expect(pprintNumber(null)).toBe("—");
    expect(pprintNumber(undefined)).toBe("—");
    expect(pprintNumber(Number.NaN)).toBe("—");
    expect(pprintNumber(Number.POSITIVE_INFINITY, { fallback: "n/a" })).toBe("n/a");
  });
});

// ==========================
// pprintPercent
// ==========================

describe("pprintPercent", () => {
  it("formats ratios as percentages", () => {
    expect(pprintPercent(0.1234, { locale: "en-US" })).toBe("12%");
    expect(pprintPercent(0.1234, { decimals: 1, locale: "en-US" })).toBe("12.3%");
    expect(pprintPercent(0.999, { decimals: 3, locale: "en-US" })).toBe("99.900%");
  });

  it("localizes the numeric part while keeping a stable percent suffix", () => {
    expect(pprintPercent(0.1234, { decimals: 1, locale: "de-DE" })).toBe("12,3%");
  });

  it("only clamps when requested", () => {
    expect(pprintPercent(1.4, { locale: "en-US" })).toBe("140%");
    expect(pprintPercent(1.4, { clamp: true, locale: "en-US" })).toBe("100%");
    expect(pprintPercent(-0.2, { clamp: true, locale: "en-US" })).toBe("0%");
  });

  it("returns the configurable fallback for invalid values", () => {
    expect(pprintPercent(null)).toBe("—");
    expect(pprintPercent(Number.NaN, { fallback: "n/a" })).toBe("n/a");
    expect(pprintPercent(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(pprintPercent(Number.MAX_VALUE)).toBe("—");
  });
});

// ==========================
// pprintDurationMs
// ==========================

describe("pprintDurationMs", () => {
  it("formats sub-millisecond and millisecond durations", () => {
    expect(pprintDurationMs(0)).toBe("0ms");
    expect(pprintDurationMs(0.4)).toBe("<1ms");
    expect(pprintDurationMs(842, { locale: "en-US" })).toBe("842ms");
  });

  it("formats seconds with magnitude-aware precision", () => {
    expect(pprintDurationMs(1_234, { locale: "en-US" })).toBe("1.23s");
    expect(pprintDurationMs(12_340, { locale: "en-US" })).toBe("12.3s");
    expect(pprintDurationMs(1_234, { locale: "de-DE" })).toBe("1,23s");
  });

  it("formats longer durations with at most two non-zero units", () => {
    expect(pprintDurationMs(90_000, { locale: "en-US" })).toBe("1m 30s");
    expect(pprintDurationMs(7_200_000, { locale: "en-US" })).toBe("2h");
    expect(pprintDurationMs(88_200_000, { locale: "en-US" })).toBe("1d 30m");
  });

  it("promotes values that round across unit boundaries", () => {
    expect(pprintDurationMs(999.6, { locale: "en-US" })).toBe("1s");
    expect(pprintDurationMs(59_999, { locale: "en-US" })).toBe("1m");
    expect(pprintDurationMs(3_599_999, { locale: "en-US" })).toBe("1h");
  });

  it("returns the configurable fallback for invalid durations", () => {
    expect(pprintDurationMs(null)).toBe("—");
    expect(pprintDurationMs(undefined, { fallback: "-" })).toBe("-");
    expect(pprintDurationMs(-1)).toBe("—");
    expect(pprintDurationMs(Number.NaN)).toBe("—");
    expect(pprintDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("text namespace", () => {
  it("exposes all pretty-printers", () => {
    expect(text.pprintNumber).toBe(pprintNumber);
    expect(text.pprintPercent).toBe(pprintPercent);
    expect(text.pprintDurationMs).toBe(pprintDurationMs);
    expect(text.pprintBytes).toBe(pprintBytes);
    expect(text.pprintBytesParts).toBe(pprintBytesParts);
  });
});

// ==========================
// truncate
// ==========================

describe("truncate", () => {
  it("returns unchanged if within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates at end with ellipsis (default mode)", () => {
    expect(truncate("Hello World", 6)).toBe("Hello…");
  });

  it("truncates in middle", () => {
    expect(truncate("Hello World", 6, "middle")).toBe("He…rld");
  });

  it("handles exact limit length (no truncation needed)", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("handles limit of 1", () => {
    expect(truncate("hello", 1)).toBe("…");
  });

  it("handles empty string", () => {
    expect(truncate("", 5)).toBe("");
  });
});

// ==========================
// summarize
// ==========================

describe("summarize", () => {
  it("returns unchanged if within limit", () => {
    expect(summarize("hello", 10)).toBe("hello");
  });

  it('adds "[N chars omitted]" suffix', () => {
    expect(summarize("Hello World", 6)).toBe("Hello… [6 chars omitted]");
  });

  it("works with middle mode", () => {
    expect(summarize("Hello World", 6, "middle")).toBe(
      "He…rld [6 chars omitted]",
    );
  });

  it("omitted count is correct", () => {
    // 20 chars, limit 10 -> 11 omitted (20 - 10 + 1)
    const input = "abcdefghijklmnopqrst"; // 20 chars
    const result = summarize(input, 10);
    expect(result).toContain("[11 chars omitted]");
  });
});

// ==========================
// camelCase
// ==========================

describe("camelCase", () => {
  it('converts "hello world" to "helloWorld"', () => {
    expect(camelCase("hello world")).toBe("helloWorld");
  });

  it('converts "Hello World" to "helloWorld"', () => {
    expect(camelCase("Hello World")).toBe("helloWorld");
  });

  it('converts "hello_world" to "helloWorld"', () => {
    expect(camelCase("hello_world")).toBe("helloWorld");
  });

  it('converts "hello-world" to "helloWorld"', () => {
    expect(camelCase("hello-world")).toBe("helloWorld");
  });

  it('converts "HelloWorld" to "helloWorld"', () => {
    expect(camelCase("HelloWorld")).toBe("helloWorld");
  });

  it('converts "HTML parser" to "htmlParser"', () => {
    expect(camelCase("HTML parser")).toBe("htmlParser");
  });
});

// ==========================
// snakeCase
// ==========================

describe("snakeCase", () => {
  it('converts "hello world" to "hello_world"', () => {
    expect(snakeCase("hello world")).toBe("hello_world");
  });

  it('converts "helloWorld" to "hello_world"', () => {
    expect(snakeCase("helloWorld")).toBe("hello_world");
  });

  it('converts "HelloWorld" to "hello_world"', () => {
    expect(snakeCase("HelloWorld")).toBe("hello_world");
  });

  it('converts "hello-world" to "hello_world"', () => {
    expect(snakeCase("hello-world")).toBe("hello_world");
  });
});

// ==========================
// kebabCase
// ==========================

describe("kebabCase", () => {
  it('converts "hello world" to "hello-world"', () => {
    expect(kebabCase("hello world")).toBe("hello-world");
  });

  it('converts "helloWorld" to "hello-world"', () => {
    expect(kebabCase("helloWorld")).toBe("hello-world");
  });

  it('converts "hello_world" to "hello-world"', () => {
    expect(kebabCase("hello_world")).toBe("hello-world");
  });
});

// ==========================
// pascalCase
// ==========================

describe("pascalCase", () => {
  it('converts "hello world" to "HelloWorld"', () => {
    expect(pascalCase("hello world")).toBe("HelloWorld");
  });

  it('converts "helloWorld" to "HelloWorld"', () => {
    expect(pascalCase("helloWorld")).toBe("HelloWorld");
  });

  it('converts "hello_world" to "HelloWorld"', () => {
    expect(pascalCase("hello_world")).toBe("HelloWorld");
  });

  it('converts "hello-world" to "HelloWorld"', () => {
    expect(pascalCase("hello-world")).toBe("HelloWorld");
  });
});
