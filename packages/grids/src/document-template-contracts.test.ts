import { describe, expect, test } from "bun:test";
import {
  CreateDocumentTemplateSchema,
  DocumentTemplateRendererSchema,
  DocumentTemplateRendererSummarySchema,
  UpdateDocumentTemplateSchema,
} from "./contracts";
import { validateTemplateWrite } from "./service/document-templates";

const htmlRenderer = {
  kind: "html" as const,
  body: "<p>{{ document.number }}</p>",
  numberTemplate: "DOC-{{ series.value }}",
  filenameTemplate: "{{ document.number }}.pdf",
};

describe("document template renderer contract", () => {
  test("round-trips one explicit HTML renderer", () => {
    expect(DocumentTemplateRendererSchema.parse(htmlRenderer)).toEqual(htmlRenderer);
    expect(DocumentTemplateRendererSummarySchema.parse({ kind: "html" })).toEqual({ kind: "html" });
    expect(DocumentTemplateRendererSummarySchema.safeParse(htmlRenderer).success).toBe(false);
    expect(
      CreateDocumentTemplateSchema.parse({
        name: "Receipt",
        source: "from table {TAB001}\nlimit 1",
        renderer: htmlRenderer,
      }),
    ).toEqual({
      name: "Receipt",
      source: "from table {TAB001}\nlimit 1",
      renderer: htmlRenderer,
    });
  });

  test("switches renderer only as one complete value", () => {
    const profile = {
      kind: "profile" as const,
      id: "de.zugferd.en16931",
      version: 1,
      inputTemplate: '{"invoice":{{ record.data | json }}}',
    };
    expect(UpdateDocumentTemplateSchema.parse({ renderer: profile })).toEqual({ renderer: profile });
    expect(DocumentTemplateRendererSchema.safeParse({ ...profile, body: "<p>ignored</p>" }).success).toBe(false);
    expect(DocumentTemplateRendererSchema.safeParse({ ...htmlRenderer, header: "   " }).success).toBe(false);
  });

  test("rejects removed top-level renderer fields instead of silently ignoring them", () => {
    expect(
      CreateDocumentTemplateSchema.safeParse({
        name: "Legacy",
        source: "from table {TAB001}\nlimit 1",
        renderer: htmlRenderer,
        html: "<p>legacy</p>",
      }).success,
    ).toBe(false);
  });

  test("returns bounded BAD_INPUT for an unknown profile renderer", () => {
    const result = validateTemplateWrite({
      renderer: { kind: "profile", id: "unknown.profile", version: 1, inputTemplate: "{}" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: "BAD_INPUT", status: 400 });
  });
});
