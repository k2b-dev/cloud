import { describe, expect, test } from "bun:test";
import { defaultDocumentNumberTemplate, defaultDocumentStarter } from "./document-template-dialog-defaults";

describe("Document template dialog defaults", () => {
  test("uses Document identity in the default number pattern", () => {
    expect(defaultDocumentNumberTemplate).toBe("{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}");
    expect(defaultDocumentStarter().renderer).toMatchObject({
      kind: "html",
      numberTemplate: defaultDocumentNumberTemplate,
    });
  });
});
