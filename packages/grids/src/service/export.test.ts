import { describe, expect, test } from "bun:test";
import { csvQuote, formatCellForExport, validateHtmlTemplateExportLimit } from "./export";
import type { Field } from "./types";

const mkField = (overrides: Partial<Field> & Pick<Field, "id" | "type">): Field => ({
  shortId: overrides.id.slice(0, 6),
  tableId: "00000000-0000-0000-0000-000000000000",
  name: overrides.id,
  description: null,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

// =============================================================================
// csvQuote — RFC 4180 quoting. Plain text passes through; cells with
// commas, quotes, CR, or LF get wrapped + internal quotes doubled.
// =============================================================================

describe("csvQuote", () => {
  test("plain ASCII without specials passes through", () => {
    expect(csvQuote("hello")).toBe("hello");
  });
  test("empty string passes through", () => {
    expect(csvQuote("")).toBe("");
  });
  test("comma triggers wrap", () => {
    expect(csvQuote("a,b")).toBe('"a,b"');
  });
  test("custom delimiter triggers wrap", () => {
    expect(csvQuote("a;b", ";")).toBe('"a;b"');
    expect(csvQuote("a,b", ";")).toBe("a,b");
  });
  test("newline triggers wrap (multi-line cell)", () => {
    expect(csvQuote("line1\nline2")).toBe('"line1\nline2"');
    expect(csvQuote("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  test("quote triggers wrap and is doubled inside", () => {
    expect(csvQuote('he said "hi"')).toBe('"he said ""hi"""');
  });
  test("only-quote string", () => {
    expect(csvQuote('"')).toBe('""""');
  });
  test("unicode without specials passes through unwrapped", () => {
    // RFC 4180 specials are limited to ASCII , " CR LF — emoji and
    // non-Latin characters don't trigger quoting.
    expect(csvQuote("Über naïve")).toBe("Über naïve");
  });

  test("neutralizes spreadsheet formulas before quoting", () => {
    expect(csvQuote("=1+1")).toBe("'=1+1");
    expect(csvQuote(" @SUM(A1:A2)")).toBe("' @SUM(A1:A2)");
    expect(csvQuote("\t=cmd|' /C calc'!A0")).toBe("'\t=cmd|' /C calc'!A0");
  });
});

// =============================================================================
// formatCellForExport — type-aware projection for CSV. Booleans become
// "true"/"false"; select fields project the human label not the id;
// arbitrary objects JSON-stringify so the column at least round-trips.
// =============================================================================

describe("formatCellForExport", () => {
  const text = mkField({ id: "fld-text", type: "text" });

  test("null / undefined → empty string", () => {
    expect(formatCellForExport(null, text)).toBe("");
    expect(formatCellForExport(undefined, text)).toBe("");
  });

  test("boolean field renders 'true' / 'false'", () => {
    const b = mkField({ id: "fld-b", type: "boolean" });
    expect(formatCellForExport(true, b)).toBe("true");
    expect(formatCellForExport(false, b)).toBe("false");
  });

  test("select projects the option label, not the id", () => {
    const sel = mkField({
      id: "fld-sel",
      type: "select",
      config: {
        options: [
          { id: "opt-1", label: "First" },
          { id: "opt-2", label: "Second" },
        ],
      },
    });
    expect(formatCellForExport(["opt-1"], sel)).toBe("First");
    expect(formatCellForExport(["opt-2"], sel)).toBe("Second");
  });

  test("select falls back to the raw id when option is unknown (deleted option)", () => {
    const sel = mkField({
      id: "fld-sel",
      type: "select",
      config: { options: [{ id: "opt-1", label: "First" }] },
    });
    expect(formatCellForExport(["opt-removed"], sel)).toBe("opt-removed");
  });

  test("select joins labels with ', '", () => {
    const sel = mkField({
      id: "fld-msel",
      type: "select",
      config: {
        options: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Bravo" },
          { id: "c", label: "Charlie" },
        ],
      },
    });
    expect(formatCellForExport(["a", "c"], sel)).toBe("Alpha, Charlie");
  });

  test("select with unknown ids falls back per-id", () => {
    const sel = mkField({
      id: "fld-msel",
      type: "select",
      config: { options: [{ id: "a", label: "Alpha" }] },
    });
    expect(formatCellForExport(["a", "missing"], sel)).toBe("Alpha, missing");
  });

  test("select with non-array value still stringifies (defensive)", () => {
    const sel = mkField({
      id: "fld-msel",
      type: "select",
      config: { options: [{ id: "a", label: "Alpha" }] },
    });
    // A scalar in a select column is unexpected, but we shouldn't
    // throw — fall through to the generic toString path.
    expect(formatCellForExport("a", sel)).toBe("a");
  });

  test("object values JSON-stringify (defensive fallback)", () => {
    const json = mkField({ id: "fld-json", type: "json" });
    expect(formatCellForExport({ amount: "24.50", unit: "EUR" }, json)).toBe('{"amount":"24.50","unit":"EUR"}');
  });

  test("array value stringifies (relation field stores uuid arrays)", () => {
    const rel = mkField({ id: "fld-rel", type: "relation" });
    expect(formatCellForExport(["a", "b"], rel)).toBe('["a","b"]');
  });

  test("number / string / non-special types coerce via String()", () => {
    expect(formatCellForExport(42, text)).toBe("42");
    expect(formatCellForExport("hello", text)).toBe("hello");
    expect(formatCellForExport(3.14, text)).toBe("3.14");
  });

  test("date-only fields export the stored calendar day", () => {
    const date = mkField({ id: "fld-date", type: "date" });
    expect(formatCellForExport("2026-05-02T23:00:00-02:00", date)).toBe("2026-05-02");
  });

  test("date-time fields export in the configured timezone", () => {
    const dateTime = mkField({ id: "fld-datetime", type: "date", config: { includeTime: true } });
    expect(
      formatCellForExport("2026-05-02T10:00:00.000Z", dateTime, {
        markdown: "raw",
        dateConfig: { timeZone: "Europe/Berlin", locale: "en", firstDayOfWeek: 1 },
      }),
    ).toBe("2026-05-02 12:00");
  });

  test("longtext can render markdown as sanitized HTML", () => {
    const md = mkField({ id: "fld-md", type: "longtext" });
    expect(formatCellForExport("**bold**", md, { markdown: "html" })).toContain("<strong>bold</strong>");
  });
});

describe("HTML template export limits", () => {
  const html = mkField({ id: "fld-html", type: "html_template" });

  test("requires an explicit bounded limit only when HTML is selected", () => {
    expect(validateHtmlTemplateExportLimit([html], {}).ok).toBe(false);
    expect(validateHtmlTemplateExportLimit([html], { limit: 1_001 }).ok).toBe(false);
    expect(validateHtmlTemplateExportLimit([html], { limit: 1_000 }).ok).toBe(true);
    expect(validateHtmlTemplateExportLimit([mkField({ id: "fld-text", type: "text" })], {}).ok).toBe(true);
  });

  test("localizes the limit error for regional German locales", () => {
    const result = validateHtmlTemplateExportLimit([html], {}, "de-CH");

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe("HTML-Vorlagenfelder erfordern ein ausdrückliches Exportlimit von höchstens 1000 Datensätzen");
  });
});
