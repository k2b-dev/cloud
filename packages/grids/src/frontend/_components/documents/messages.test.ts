import { describe, expect, test } from "bun:test";
import { DOCUMENT_TEMPLATE_STARTERS } from "../../../document-template-starters";
import { defaultDocumentStarter } from "../dialogs/document-template-dialog-defaults";
import { documentMessages, documentStarterPresentation } from "./messages";

describe("document UI messages", () => {
  test("keeps every locale complete", () => expect(documentMessages.check()).toEqual([]));

  test("falls back from regional German", () => {
    const messages = documentMessages.resolve(["de-CH"]).t;
    expect(messages.documentDetails).toBe("Dokumentdetails");
    expect(messages.immutableGeneratedDocumentDetail).toContain("Artefakte");
    expect(messages.failedToRenderPdf).toBe("PDF konnte nicht erzeugt werden");
  });

  test("localizes starter presentation without changing its technical payload", () => {
    const starter = defaultDocumentStarter();
    const presentation = documentStarterPresentation(starter, "de-CH");

    expect(presentation.name).toBe("Leere Vorlage");
    expect(presentation.page).toBe("A4 Hochformat");
    expect(starter.id).toBe("blank");
    expect(starter.source("table-id")).toContain("from table {table-id}");
    expect(starter.renderer.kind).toBe("html");
  });

  test("covers every built-in starter without translating technical template data", () => {
    for (const starter of DOCUMENT_TEMPLATE_STARTERS) {
      const presentation = documentStarterPresentation(starter, "de-CH");
      expect(presentation.name).not.toBe(starter.name);
      expect(presentation.description).not.toBe(starter.description);
      expect(starter.source("table-id")).toContain("{table-id}");
    }
    expect(documentMessages.resolve(["de-CH"]).t.chooseRenderer).toContain("E-Invoice");
  });
});
