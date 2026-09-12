import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { QueryExportStarter, queryExportMessages, queryExportTemplates } = await import("./QueryExportStarter");

test("query export starts with schema-aware GQL and requires a preview before file options", () => {
  const html = renderToString(() =>
    createComponent(QueryExportStarter, {
      baseId: "BASE01",
      tables: [],
      fieldsByTable: {},
      onDirty: () => {},
      onComplete: () => {},
    }),
  );
  expect(html).toContain("GQL query");
  expect(html).toContain("Preview data");
  expect(html).toContain("Choose file format");
  expect(html).toContain("disabled");
  expect(html).toContain("not the export snapshot");
  expect(html).not.toContain("CSV delimiter");
  expect(html).not.toContain("Workflow name");
  expect(queryExportMessages.resolve(["de"]).t.review).toBe("Workflow prüfen");
});

test("the actual PDF starter escapes headings and cells exactly once", async () => {
  const { renderDocumentHtmlPdf } = await import("../../../service/document-rendering");
  let html = "";
  const result = await renderDocumentHtmlPdf(
    {
      content: { body: queryExportTemplates.pdf },
      filename: "starter.pdf",
      data: { rows: [{ q_col_0: "<Camera> & lens" }], columns: [{ key: "q_col_0", label: "Name & label" }], document: {} },
    },
    "en",
    {
      config: { url: "http://renderer.invalid", timeoutMs: 1000, maxHtmlBytes: 10_000, maxPdfBytes: 10_000 },
      fetch: async (_url, init) => {
        if (!(init?.body instanceof FormData)) throw new Error("Expected PDF form data");
        for (const file of init.body.getAll("files")) if (file instanceof File && file.name === "index.html") html = await file.text();
        return new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } });
      },
    },
  );
  expect(result.ok).toBe(true);
  expect(html).toContain("<th>Name &amp; label</th>");
  expect(html).toContain("<td>&lt;Camera&gt; &amp; lens</td>");
  expect(html).not.toContain("&amp;lt;");
});
