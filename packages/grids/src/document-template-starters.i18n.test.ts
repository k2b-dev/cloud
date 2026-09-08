import { describe, expect, test } from "bun:test";
import { DOCUMENT_TEMPLATE_STARTERS, documentTemplateStarterById, getDocumentTemplateStarters } from "./document-template-starters";

describe("document template starter localization", () => {
  test("does not assert operational checks that document generation never performs", () => {
    for (const locale of ["en", "de-DE"]) {
      const starters = getDocumentTemplateStarters(locale);
      const bodies = starters.map((starter) => starter.renderer.body).join("\n");
      expect(bodies).not.toContain("generated from approved operational records");
      expect(bodies).not.toContain("Identification checked before handover");
      expect(bodies).not.toContain("Identität vor Übergabe geprüft");
      expect(bodies).toContain('class="checkbox"');
    }
  });
  test("preserves the existing English starter objects by default", () => {
    expect(getDocumentTemplateStarters()).toBe(DOCUMENT_TEMPLATE_STARTERS);
    expect(documentTemplateStarterById("invoice")).toBe(DOCUMENT_TEMPLATE_STARTERS[0]);
  });

  test("localizes metadata and generated document copy for de-CH", () => {
    const invoice = documentTemplateStarterById("invoice", "de-CH");
    expect(invoice?.name).toBe("Rechnung");
    expect(invoice?.renderer.body).toContain("<h1>Rechnung</h1>");
    expect(invoice?.renderer.body).toContain("Zahlungshinweise");
    expect(invoice?.renderer.footer).toContain("Seite ");
    expect(invoice?.source("table-id")).toBe(DOCUMENT_TEMPLATE_STARTERS[0]!.source("table-id"));
    expect(invoice?.renderer.numberTemplate).toBe(DOCUMENT_TEMPLATE_STARTERS[0]!.renderer.numberTemplate);
  });

  test("returns an independent localized collection", () => {
    const german = getDocumentTemplateStarters("de-DE");
    expect(german).not.toBe(DOCUMENT_TEMPLATE_STARTERS);
    expect(german).toHaveLength(DOCUMENT_TEMPLATE_STARTERS.length);
    expect(german.every((starter) => starter.name.length > 0 && starter.description.length > 0)).toBe(true);
    const visibleCopy = german.flatMap((starter) => [starter.renderer.header, starter.renderer.body, starter.renderer.footer]).join("\n");
    for (const english of ["Services and goods", "Prepared for signature", "Borrower initials", "Report overview", "Logistics"]) {
      expect(visibleCopy).not.toContain(english);
    }
  });
});
