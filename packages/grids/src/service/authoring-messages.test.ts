import { describe, expect, test } from "bun:test";
import { gqlDiagnosticsForLocale } from "../api/gql-runtime";
import { checkFormula } from "./formula-preview";
import { checkHtmlTemplate } from "./html-template-preview";

describe("localized authoring diagnostics", () => {
  test("localizes formula diagnostics for regional German locales without translating identifiers", async () => {
    const empty = await checkFormula({ tableId: "unused", expression: " ", dateConfig: { locale: "de-CH", timeZone: "UTC" } });
    expect(empty.ok && empty.data.diagnostics).toEqual([
      {
        code: "formula.empty",
        severity: "info",
        message: "Gib eine Formel ein, um die neuesten Datensätze als Vorschau anzuzeigen.",
      },
    ]);

    const invalid = await checkFormula({ tableId: "unused", expression: "LEN(", dateConfig: { locale: "de-CH", timeZone: "UTC" } });
    expect(invalid.ok && invalid.data.diagnostics).toEqual([
      {
        code: "formula.syntax",
        severity: "error",
        message: "Die Formel enthält einen Syntaxfehler. Prüfe die markierte Stelle.",
      },
    ]);
  });

  test("localizes HTML-template hints and keeps a stable code", async () => {
    const result = await checkHtmlTemplate({
      tableId: "unused",
      fieldId: "unused",
      template: "",
      css: "",
      dateConfig: { locale: "de-CH", timeZone: "UTC" },
    });
    expect(result.ok && result.data.diagnostics).toEqual([
      {
        code: "html.empty",
        severity: "info",
        message: "Gib eine HTML-Vorlage ein, um die neuesten Datensätze als Vorschau anzuzeigen.",
      },
    ]);
  });

  test("localizes GQL stages without inspecting the English diagnostic text", () => {
    expect(gqlDiagnosticsForLocale([{ line: 2, column: 4, message: "arbitrary parser detail" }], "de-CH", "gql.syntax")).toEqual([
      {
        code: "gql.syntax",
        line: 2,
        column: 4,
        message: "Die GQL-Syntax ist ungültig. Prüfe die markierte Stelle. arbitrary parser detail",
      },
    ]);
    expect(gqlDiagnosticsForLocale([{ message: "unknown foo" }], "de-DE", "gql.resolution")[0]?.message).toContain(
      "unbekannt oder nicht verfügbar",
    );
    expect(
      gqlDiagnosticsForLocale([{ message: 'select alias "item" conflicts with a source field' }], "de", "gql.resolution")[0]?.message,
    ).toContain('select alias "item" conflicts with a source field');
    expect(gqlDiagnosticsForLocale([{ message: "expected ')'" }], "en", "gql.syntax")).toEqual([
      { code: "gql.syntax", message: "expected ')'" },
    ]);
  });
});
