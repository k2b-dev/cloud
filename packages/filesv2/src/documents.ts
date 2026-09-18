/** Office document kinds Collabora edits in place; shared by server, browser and CLI. */
export const DOCUMENT_KINDS = ["text", "spreadsheet", "presentation"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DOCUMENT_FORMATS = ["odf", "ooxml"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

const EXTENSIONS: Record<DocumentFormat, Record<DocumentKind, string>> = {
  odf: { text: "odt", spreadsheet: "ods", presentation: "odp" },
  ooxml: { text: "docx", spreadsheet: "xlsx", presentation: "pptx" },
};
/** Extension of a new document in the administrator's configured format. */
export const documentExtension = (kind: DocumentKind, format: DocumentFormat) => EXTENSIONS[format][kind];
const EDITABLE = new Set(Object.values(EXTENSIONS).flatMap((kinds) => Object.values(kinds)));
/** The lowercase extension when Collabora can edit this file name, otherwise null. */
export function editableExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  return EDITABLE.has(extension) ? extension : null;
}
