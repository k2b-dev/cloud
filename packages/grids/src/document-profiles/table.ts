import { z } from "zod";
import { DocumentHtmlContentSchema } from "../contracts";
import type { DocumentProfile } from "../document-profiles";
import { canonicalDocumentJson } from "../service/document-json";
import { renderDocumentHtmlPdf } from "../service/document-rendering";
import { DocumentCsvOutputSchema, DocumentJsonOutputSchema, renderDocumentTableOutput } from "../service/document-table-output";
import { renderDocumentXml } from "../service/document-xml";

const tableInput = z
  .object({
    columns: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), type: z.string(), sqlType: z.string() }).strict()).min(1),
    rows: z.array(z.record(z.string(), z.json())),
    filename: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const csvInput = tableInput.extend({
  options: DocumentCsvOutputSchema.omit({ kind: true }).optional(),
});
const jsonInput = tableInput.extend({ options: DocumentJsonOutputSchema.omit({ kind: true }).optional() });

const pdfInput = tableInput.extend({ content: DocumentHtmlContentSchema });
const xmlInput = tableInput.extend({ body: z.string().trim().min(1).max(200_000) });

export const xmlTableDocumentProfile: DocumentProfile<z.infer<typeof xmlInput>> = {
  id: "grids.xml",
  version: 1,
  title: "XML report",
  description: "UTF-8 XML 1.0 from captured rows and a restricted Liquid template.",
  rendererVersion: "grids-liquid-xml-v1",
  validatorVersion: "grids-xml-1.0-xmldom-0.9.12-v1",
  primaryArtifact: { key: "xml", mediaType: "application/xml" },
  input: xmlInput,
  formatNumber: ({ value }) => `XML-${value}`,
  issue(input, context) {
    canonicalDocumentJson(input);
    const rendered = renderDocumentXml(input.body, {
      rows: input.rows,
      columns: input.columns,
      document: { number: context.number, createdAt: context.issuedAt.toISOString() },
    });
    if (!rendered.ok) throw rendered.error;
    return {
      artifacts: [
        {
          key: "xml",
          filename: input.filename ?? `${context.number}.xml`,
          mediaType: "application/xml",
          bytes: new TextEncoder().encode(rendered.data),
        },
      ],
      validationStatus: "valid",
      validationReport: { rowCount: input.rows.length, xmlVersion: "1.0" },
    };
  },
};

export const pdfTableDocumentProfile: DocumentProfile<z.infer<typeof pdfInput>> = {
  id: "grids.pdf",
  version: 1,
  title: "PDF report",
  description: "A single PDF from captured rows and an HTML/Liquid template.",
  rendererVersion: "grids-liquid-gotenberg-v1",
  validatorVersion: "grids-html-v1",
  primaryArtifact: { key: "pdf", mediaType: "application/pdf" },
  input: pdfInput,
  formatNumber: ({ value }) => `PDF-${value}`,
  async issue(input, context) {
    canonicalDocumentJson(input);
    const filename = input.filename ?? `${context.number}.pdf`;
    const rendered = await renderDocumentHtmlPdf({
      content: input.content,
      data: {
        rows: input.rows,
        columns: input.columns,
        document: { number: context.number, createdAt: context.issuedAt.toISOString() },
      },
      filename,
    });
    if (!rendered.ok) throw rendered.error;
    return {
      artifacts: [{ key: "pdf", filename, mediaType: rendered.data.contentType, bytes: rendered.data.pdf }],
      validationStatus: "valid",
      validationReport: { rowCount: input.rows.length },
    };
  },
};

export const csvDocumentProfile: DocumentProfile<z.infer<typeof csvInput>> = {
  id: "grids.csv",
  version: 1,
  title: "CSV table",
  description: "UTF-8 CSV using typed columns and exact decimal values.",
  rendererVersion: "grids-csv-v1",
  validatorVersion: "grids-table-v1",
  primaryArtifact: { key: "csv", mediaType: "text/csv" },
  input: csvInput,
  formatNumber: ({ value }) => `CSV-${value}`,
  issue(input, context) {
    const rendered = renderDocumentTableOutput({
      data: input,
      output: { kind: "csv", ...input.options },
      filename: input.filename ?? `${context.number}.csv`,
    });
    if (!rendered.ok) throw rendered.error;
    return {
      artifacts: [rendered.data.artifact],
      validationStatus: rendered.data.protectedCells ? "warning" : "valid",
      validationReport: { rowCount: input.rows.length, protectedCells: rendered.data.protectedCells },
    };
  },
};

export const jsonDocumentProfile: DocumentProfile<z.infer<typeof jsonInput>> = {
  id: "grids.json",
  version: 1,
  title: "JSON table",
  description: "Typed row objects using column aliases as property names.",
  rendererVersion: "grids-json-v1",
  validatorVersion: "grids-table-v1",
  primaryArtifact: { key: "json", mediaType: "application/json" },
  input: jsonInput,
  formatNumber: ({ value }) => `JSON-${value}`,
  issue(input, context) {
    const rendered = renderDocumentTableOutput({
      data: input,
      output: { kind: "json", ...input.options },
      filename: input.filename ?? `${context.number}.json`,
    });
    if (!rendered.ok) throw rendered.error;
    return { artifacts: [rendered.data.artifact], validationStatus: "valid", validationReport: { rowCount: input.rows.length } };
  },
};
