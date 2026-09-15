import { parseGridsQueryDsl } from "../query-dsl/parser";

/** Preview grants a stored data product, not user-controlled query text.
 * Renderer Liquid may use data; source Liquid may only insert the trusted ID.
 */
export const customAppDocumentPreviewSourceIsSafe = (source: string): boolean => {
  const staticSource = source.replace(/\{\{\s*record\.(?:id|shortId)\s*\}\}/g, "ABC123");
  if (/\{[\{%#]/.test(staticSource)) return false;
  return parseGridsQueryDsl(staticSource).ok;
};
