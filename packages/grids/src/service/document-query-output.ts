import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { DocumentHtmlContentSchema } from "../contracts";
import { FinancialDocumentOutputSchema } from "./document-financial-output";
import { validateDocumentLiquidTemplate } from "./document-liquid";
import { documentServiceText } from "./document-messages";
import { DocumentTableOutputSchema } from "./document-table-output";
import { validateDocumentXmlTemplate } from "./document-xml";
import { DocumentZipOutputSchema } from "./document-zip-output";

export const DocumentQueryOutputSchema = z.union([
  DocumentTableOutputSchema,
  DocumentHtmlContentSchema.extend({ kind: z.literal("pdf") }),
  z.object({ kind: z.literal("xml"), body: z.string().trim().min(1).max(200_000) }).strict(),
  FinancialDocumentOutputSchema,
  DocumentZipOutputSchema,
]);

const queryTemplateRoots = new Set(["rows", "columns", "document"]);

export const validateDocumentQueryOutput = (output: unknown, locale?: string): Result<void> => {
  const parsed = DocumentQueryOutputSchema.safeParse(output);
  if (!parsed.success) return fail(err.badInput(documentServiceText(locale).tableOutputInvalid));
  if (parsed.data.kind === "xml") return validateDocumentXmlTemplate(parsed.data.body, locale);
  if (parsed.data.kind === "pdf") {
    for (const key of ["body", "header", "footer", "css"] as const) {
      const source = parsed.data[key];
      if (source === undefined) continue;
      const checked = validateDocumentLiquidTemplate(source, key, queryTemplateRoots, locale);
      if (!checked.ok) return checked;
    }
  }
  return ok();
};
