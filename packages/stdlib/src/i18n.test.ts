import { describe, it, expect } from "bun:test";
import { defineCatalog, parseAcceptLanguage, plural, formatList, compare, i18n } from "./i18n";

// ==========================
// defineCatalog / resolve
// ==========================

const catalog = defineCatalog({
  baseLocale: "en",
  messages: {
    en: {
      title: "Inbox",
      greeting: ({ name }: { name: string }) => `Hello ${name}`,
      items: ({ count }: { count: number }) =>
        plural(count, "en", { one: `${count} item`, other: `${count} items` }),
    },
    de: {
      title: "Eingang",
      // Untyped param destructuring must be contextually typed from the base locale.
      greeting: ({ name }) => `Hallo ${name}`,
    },
    "de-CH": {
      greeting: ({ name }) => `Grüezi ${name}`,
    },
  },
});

describe("defineCatalog", () => {
  it("lists locales with the base locale first", () => {
    expect(catalog.baseLocale).toBe("en");
    expect(catalog.locales).toEqual(["en", "de", "de-CH"]);
  });

  it("resolves an exact locale", () => {
    const { locale, t } = catalog.resolve(["de"]);
    expect(locale).toBe("de");
    expect(t.greeting({ name: "Ada" })).toBe("Hallo Ada");
    expect(t.title).toBe("Eingang");
  });

  it("falls back across subtags: de-AT -> de", () => {
    const { locale, t } = catalog.resolve(["de-AT", "en"]);
    expect(locale).toBe("de");
    expect(t.greeting({ name: "Ada" })).toBe("Hallo Ada");
  });

  it("prefers a regional variant when defined", () => {
    const { locale, t } = catalog.resolve(["de-CH"]);
    expect(locale).toBe("de-CH");
    expect(t.greeting({ name: "Ada" })).toBe("Grüezi Ada");
  });

  it("matches locale tags case-insensitively", () => {
    expect(catalog.resolve(["DE-ch"]).locale).toBe("de-CH");
  });

  it("tries requested tags in order", () => {
    expect(catalog.resolve(["fr", "de"]).locale).toBe("de");
  });

  it("falls back to the base locale when nothing matches", () => {
    expect(catalog.resolve(["fr", "ja"]).locale).toBe("en");
    expect(catalog.resolve([]).locale).toBe("en");
    expect(catalog.resolve().locale).toBe("en");
  });

  it("fills missing keys hierarchically: de-CH -> de -> base", () => {
    const { t } = catalog.resolve(["de-CH"]);
    expect(t.greeting({ name: "Ada" })).toBe("Grüezi Ada"); // own key wins
    expect(t.title).toBe("Eingang"); // inherited from "de", not base
    expect(t.items({ count: 2 })).toBe("2 items"); // falls through to base
  });

  it("merges deep tags through every defined ancestor", () => {
    const deep = defineCatalog({
      baseLocale: "en",
      messages: {
        en: { a: "a-en", b: "b-en", c: "c-en" },
        zh: { a: "a-zh", b: "b-zh", c: "c-zh" },
        "zh-Hant": { b: "b-hant" },
        "zh-Hant-TW": { c: "c-tw" },
      },
    });
    const { locale, t } = deep.resolve(["zh-Hant-TW"]);
    expect(locale).toBe("zh-Hant-TW");
    expect(t).toEqual({ a: "a-zh", b: "b-hant", c: "c-tw" });
  });

  it("merges ancestors case-insensitively", () => {
    const mixed = defineCatalog({
      baseLocale: "en",
      messages: {
        en: { a: "a-en", b: "b-en" },
        DE: { a: "a-de", b: "b-de" },
        "de-ch": { a: "a-ch" },
      },
    });
    const { locale, t } = mixed.resolve(["de-CH"]);
    expect(locale).toBe("de-ch");
    expect(t).toEqual({ a: "a-ch", b: "b-de" });
  });
});

// ==========================
// check
// ==========================

describe("catalog.check", () => {
  it("returns no issues for complete locales", () => {
    const complete = defineCatalog({
      baseLocale: "en",
      messages: {
        en: { hello: "Hello" },
        de: { hello: "Hallo" },
      },
    });
    expect(complete.check()).toEqual([]);
  });

  it("reports missing and extra keys per locale", () => {
    const sloppy = defineCatalog({
      baseLocale: "en",
      messages: {
        en: { hello: "Hello", bye: "Bye" },
        de: { hello: "Hallo", ...{ helo: "Tippfehler" } },
      },
    });
    expect(sloppy.check()).toEqual([{ locale: "de", missing: ["bye"], extra: ["helo"] }]);
  });

  it("treats ancestor-provided keys as covered", () => {
    const regional = defineCatalog({
      baseLocale: "en",
      messages: {
        en: { hello: "Hello", bye: "Bye" },
        de: { hello: "Hallo" },
        "de-CH": {},
      },
    });
    // "hello" is covered for de-CH via "de"; "bye" falls through to base everywhere.
    expect(regional.check()).toEqual([
      { locale: "de", missing: ["bye"], extra: [] },
      { locale: "de-CH", missing: ["bye"], extra: [] },
    ]);
  });
});

// ==========================
// Compile-time contract
// ==========================

describe("type safety", () => {
  it("rejects incompatible message parameters at compile time", () => {
    defineCatalog({
      baseLocale: "en",
      messages: {
        en: { greeting: ({ name }: { name: string }) => `Hello ${name}` },
        // @ts-expect-error parameter shape must match the base locale
        de: { greeting: ({ nome }: { nome: string }) => `Ciao ${nome}` },
      },
    });

    defineCatalog({
      baseLocale: "en",
      messages: {
        // @ts-expect-error messages must contain the base locale
        de: { hello: "Hallo" },
      },
    });

    expect(true).toBe(true);
  });
});

// ==========================
// parseAcceptLanguage
// ==========================

describe("parseAcceptLanguage", () => {
  it("sorts by quality, missing q counts as 1", () => {
    expect(parseAcceptLanguage("en;q=0.8, de-AT")).toEqual(["de-AT", "en"]);
    expect(parseAcceptLanguage("de-AT;q=0.9, en;q=0.8")).toEqual(["de-AT", "en"]);
  });

  it("keeps header order on ties", () => {
    expect(parseAcceptLanguage("de, en")).toEqual(["de", "en"]);
  });

  it("drops wildcards and q=0 entries", () => {
    expect(parseAcceptLanguage("de;q=0, *, en")).toEqual(["en"]);
  });

  it("ignores malformed quality values", () => {
    expect(parseAcceptLanguage("de;q=abc, en")).toEqual(["en"]);
  });

  it("handles null, undefined, and empty headers", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

// ==========================
// plural
// ==========================

describe("plural", () => {
  it("selects CLDR categories per locale", () => {
    const forms = { one: "one", other: "other" };
    expect(plural(1, "en", forms)).toBe("one");
    expect(plural(2, "en", forms)).toBe("other");
  });

  it("supports locales with more than two categories", () => {
    const forms = { one: "plik", few: "pliki", many: "plików", other: "pliku" };
    expect(plural(1, "pl", forms)).toBe("plik");
    expect(plural(2, "pl", forms)).toBe("pliki");
    expect(plural(5, "pl", forms)).toBe("plików");
  });

  it("falls back to other for omitted categories", () => {
    expect(plural(2, "pl", { other: "fallback" })).toBe("fallback");
  });
});

// ==========================
// formatList
// ==========================

describe("formatList", () => {
  it("joins with locale-aware conjunctions", () => {
    expect(formatList(["Tue", "Wed", "Fri"], "en")).toBe("Tue, Wed, and Fri");
    expect(formatList(["Di", "Mi", "Fr"], "de")).toBe("Di, Mi und Fr");
  });

  it("supports disjunctions", () => {
    expect(formatList(["Di", "Mi"], "de", { type: "disjunction" })).toBe("Di oder Mi");
  });

  it("handles single-item and empty lists", () => {
    expect(formatList(["Di"], "de")).toBe("Di");
    expect(formatList([], "de")).toBe("");
  });
});

// ==========================
// compare
// ==========================

describe("compare", () => {
  it("sorts with locale-aware collation", () => {
    expect(["Öl", "Apfel", "Zebra"].sort(compare("de"))).toEqual(["Apfel", "Öl", "Zebra"]);
  });

  it("passes collator options through", () => {
    expect(compare("de", { sensitivity: "base" })("a", "A")).toBe(0);
  });
});

// ==========================
// Namespace export
// ==========================

describe("i18n namespace", () => {
  it("exposes all utilities", () => {
    expect(i18n.define).toBe(defineCatalog);
    expect(i18n.parseAcceptLanguage).toBe(parseAcceptLanguage);
    expect(i18n.plural).toBe(plural);
    expect(i18n.formatList).toBe(formatList);
    expect(i18n.compare).toBe(compare);
  });
});
