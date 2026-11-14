import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { DocumentTemplateEditorPanes } from "./DocumentTemplateEditorPanes";

const text = (value: string) => () => value;

describe("document template editor panes", () => {
  test("stay fixed in the dialog: tabs only, no grips, no Arrange button, no boundary to drag", () => {
    const html = renderToString(() =>
      createComponent(DocumentTemplateEditorPanes, {
        rendererKind: () => "html" as const,
        body: text("<p>{{ title }}</p>"),
        setBody: () => undefined,
        header: text(""),
        setHeader: () => undefined,
        footer: text(""),
        setFooter: () => undefined,
        css: text(""),
        setCss: () => undefined,
        templateVariables: () => [],
        previewData: () => null,
        previewDataLoading: () => false,
        previewDataError: () => null,
        source: text(""),
        previewRecordId: text(""),
        previewPdf: async () => new Response(),
      }),
    );

    expect(html).toContain("data-k2b-panes");
    expect(html.match(/role="tablist"/g)?.length).toBe(2);
    expect(html).not.toContain("k2b-panes__grip");
    expect(html).not.toContain("k2b-panes__arrange");
    expect(html).not.toContain('aria-haspopup="menu"');
  });
});
