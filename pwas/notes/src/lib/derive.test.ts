import { describe, expect, test } from "bun:test";
import { deriveLines, deriveMeta } from "./derive";

describe("deriveMeta", () => {
  test("title, ordered unicode tags, headings and code exclusions", () => {
    const text =
      "# **Titel**\n#Äpfel #tag #ÄPFEL\nProsa mit `#inline` und #tag.\n## Zweite\n# Weitere\n```md\n#falsch\n## Nein\n```\n    #auchfalsch\n~~~\n#falsch\n~~~";
    const meta = deriveMeta(text);
    expect(meta.title).toBe("Titel");
    expect(meta.tags).toEqual(["äpfel", "tag"]);
    expect(meta.headings).toEqual(["Zweite", "Weitere"]);
    expect(meta.excerpt).toBe("Prosa mit und.");
    expect(meta.length).toBe(text.length);
    expect(deriveLines(text)).not.toContain("falsch");
  });
  test("first nonempty line, tasks, excerpt limit, file reference", () => {
    const meta = deriveMeta(
      "\nEin **Titel**\n" +
        "a".repeat(300) +
        "\n- [ ] **Aufgabe** [Link](https://example.com)\n- [x] Fertig\n- [ ] zwei\n- [ ] drei\n- [ ] vier\n![Bild](file:ABC123)",
    );
    expect(meta.title).toBe("Ein Titel");
    expect(meta.excerpt.length).toBe(240);
    expect(meta.tasks).toEqual([
      { done: false, text: "Aufgabe Link" },
      { done: false, text: "zwei" },
      { done: false, text: "drei" },
    ]);
    expect(meta.image).toBe("ABC123");
    expect(deriveMeta("").title).toBe("");
  });
  test("first numeric table column with German decimal values and chart fence", () => {
    const table = "# Umsatz\n| Monat | Wert |\n| --- | ---: |\n| Jan | 1.234,56 |\n| Feb | -2,5 |\n";
    expect(deriveMeta(table).chart).toEqual({ kind: "bar", values: [1234.56, -2.5] });
    expect(deriveMeta(table + "```chart\ntype: area\n```\n").chart?.kind).toBe("line");
    expect(deriveMeta("# N\n```\n" + table + "```").chart).toBeNull();
    expect(deriveMeta("# N\n| A | B |\n|---|---|\n| x | no |\n\n" + table).chart?.values).toEqual([1234.56, -2.5]);
  });
});

test("chart fences must be actual fences; German grouped integers are numeric", () => {
  const table = "# Table\n| Name | Wert |\n| --- | --- |\n| A | 1.234.567 |\n| B | 1.000 |\n";
  expect(deriveMeta(table).chart?.values).toEqual([1234567, 1000]);
  expect(deriveMeta(table + "````md\n```chart\ntype: line\n```\n````").chart?.kind).toBe("bar");
});

test("Notebooks chart blocks give the preview and stay out of the excerpt", () => {
  const markdown =
    "# Kaffee\n\nVorher.\n\n:::chart\ntype: line\ntitle: Tassen\ncolumns: [Monat, Tassen]\nrows:\n  - [Juli, 48]\n  - [August, 61]\n:::\n\n:::note\nNur ein Hinweis.\n:::\n";
  const meta = deriveMeta(markdown);
  expect(meta.chart).toEqual({ kind: "line", values: [48, 61] });
  expect(meta.excerpt).toBe("Vorher. Nur ein Hinweis.");
});

test("long runs of Markdown punctuation derive in linear time", () => {
  // Shared notes come from strangers, so a pattern that backtracks would freeze the overview of whoever opens one.
  const n = 200_000;
  for (const text of ["`".repeat(n), `a${" ".repeat(n)}x`, "[".repeat(n), "](".repeat(n), "<".repeat(n), "![".repeat(n)]) {
    const start = performance.now();
    deriveMeta(text);
    expect(performance.now() - start).toBeLessThan(1_000);
  }
});
