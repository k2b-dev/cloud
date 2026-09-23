import { type DateContext, dates, fileIcons } from "@k2b/stdlib";
import type { PublicDocument } from "./public-document-types";

export const formatDocumentRelativeTime = (iso: string, dateConfig?: DateContext): string => dates.formatDateTimeRelative(iso, dateConfig);

export const formatDocumentDateTime = (iso: string, dateConfig?: DateContext): string =>
  new Intl.DateTimeFormat(dateConfig?.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: dateConfig?.timeZone,
  }).format(new Date(iso));

export const formatDocumentMonth = (year: string, month: string, dateConfig?: DateContext): string => {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat(dateConfig?.locale, { month: "long", timeZone: "UTC" }).format(date);
};

const FORMAT_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "text/csv": "CSV",
  "application/json": "JSON",
  "application/xml": "XML",
  "application/zip": "ZIP",
};

/** Short, locale-independent format name for a stored artifact's media type. */
export const documentFormatLabel = (mimeType: string | undefined): string => (mimeType ? (FORMAT_LABELS[mimeType] ?? mimeType) : "");

/** Tabler icon class for a Document's stored primary file, not always a PDF. */
export const documentFileIcon = (document: Pick<PublicDocument, "artifacts" | "primaryArtifactKey" | "filename">): string => {
  const primary = document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey);
  return `ti ${fileIcons.getFileIcon({ name: primary?.filename ?? document.filename, type: "file", mimeType: primary?.mimeType })}`;
};
