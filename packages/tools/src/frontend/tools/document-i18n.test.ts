import { describe, expect, test } from "bun:test";
import { documentMarkdownMessages } from "@/api/document-markdown-messages";
import { markdownPdfMessages } from "@/api/markdown-pdf-messages";

describe("document tool messages", () => {
  test("ship a complete German catalog", () => {
    expect(documentMarkdownMessages.check()).toEqual([]);
    expect(markdownPdfMessages.check()).toEqual([]);
  });

  test("resolve representative English and German copy", () => {
    const en = documentMarkdownMessages.resolve(["en"]).t;
    const de = documentMarkdownMessages.resolve(["de"]).t;

    expect(en.documentTooLarge).toBe("The document exceeds the 20 MB limit.");
    expect(de.documentTooLarge).toBe("Das Dokument überschreitet das Limit von 20 MB.");
    expect(de.conversionBusy).toBe("Der Dokumentkonverter ist ausgelastet. Versuche es gleich erneut.");
    expect(de.cancel).toBe("Abbrechen");
    expect(de.convertingFile({ filename: "bericht.pdf" })).toBe("bericht.pdf wird konvertiert…");
    expect(de.resultMeta({ format: "DOCX", input: "2 KB", output: "48 B" })).toBe("DOCX · Eingabe: 2 KB · Markdown: 48 B");

    const pdfDe = markdownPdfMessages.resolve(["de"]).t;
    expect(pdfDe.rendererBusy).toBe("Der PDF-Renderer ist ausgelastet. Versuche es gleich erneut.");
    expect(pdfDe.templateLabel).toBe("Vorlage");
    expect(pdfDe.generatePdf).toBe("PDF erstellen");
  });

  test("resolve de-CH through the de catalog", () => {
    expect(documentMarkdownMessages.resolve(["de-CH"]).locale).toBe("de");
    expect(documentMarkdownMessages.resolve(["de-CH"]).t.previewTitle).toBe("Markdown-Vorschau");
    expect(markdownPdfMessages.resolve(["de-CH"]).t.previewTitle).toBe("PDF-Vorschau");
  });

  test("keeps stable error codes while localizing the server message", async () => {
    const { createDocumentMarkdownRoutes, DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES } = await import("@/api/document-markdown");
    const app = createDocumentMarkdownRoutes({
      authenticate: async (_c, next) => next(),
      rateLimiter: async (_c, next) => next(),
      extract: async () => {
        throw new Error("must not run");
      },
    });

    const response = await app.request("/markdown", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(DOCUMENT_MARKDOWN_MAX_REQUEST_BYTES + 1),
        "x-cloud-locale": "de",
      },
      body: "--x--\r\n",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "input_too_large",
      message: "Das Dokument überschreitet das Limit von 20 MB.",
    });
  });
});
