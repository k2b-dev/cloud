export const NOTE_PDF_OMISSION_CODES = [
  "not_found",
  "unsupported_format",
  "unreadable",
  "too_large",
  "over_budget",
  "unreachable",
  "blocked",
  "timed_out",
  "not_rendered",
  "invalid_block",
] as const;
export type NotePdfOmissionCode = (typeof NOTE_PDF_OMISSION_CODES)[number];
export const NOTE_PDF_OMISSION_KINDS = ["image", "diagram", "query", "toc", "data", "chart", "map", "callout", "math", "formula"] as const;
export type NotePdfOmissionKind = (typeof NOTE_PDF_OMISSION_KINDS)[number];
export type NotePdfOmission = { code: NotePdfOmissionCode; kind: NotePdfOmissionKind; label: string };
export type NotePdfOmissionReport = { items: NotePdfOmission[]; more: number };
export const NOTE_PDF_OMISSIONS_HEADER = "X-Notebooks-Pdf-Omissions";
// Product choice: headroom under nginx's default 4 KiB header buffer.
export const NOTE_PDF_OMISSIONS_HEADER_MAX_BYTES = 2048;
// Product choice, in Unicode code points.
export const NOTE_PDF_OMISSION_LABEL_MAX = 80;

export const notePdfOmissionLabel = (raw: string): string => {
  const points = Array.from(raw.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").trim());
  return points.length > NOTE_PDF_OMISSION_LABEL_MAX ? `${points.slice(0, NOTE_PDF_OMISSION_LABEL_MAX - 1).join("")}…` : points.join("");
};

const encodeReport = (report: NotePdfOmissionReport): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

export const encodeNotePdfOmissions = (omissions: readonly NotePdfOmission[]): string | null => {
  if (!omissions.length) return null;
  const items: NotePdfOmission[] = [];
  let value = encodeReport({ items, more: omissions.length });
  for (const omission of omissions) {
    items.push({ code: omission.code, kind: omission.kind, label: notePdfOmissionLabel(omission.label) });
    const next = encodeReport({ items, more: omissions.length - items.length });
    if (next.length > NOTE_PDF_OMISSIONS_HEADER_MAX_BYTES) break;
    value = next;
  }
  return value;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCode = (value: unknown): value is NotePdfOmissionCode => NOTE_PDF_OMISSION_CODES.some((code) => code === value);
const isKind = (value: unknown): value is NotePdfOmissionKind => NOTE_PDF_OMISSION_KINDS.some((kind) => kind === value);

export const decodeNotePdfOmissions = (value: string | null | undefined): NotePdfOmissionReport | null => {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    );
    if (!isObject(decoded) || !Array.isArray(decoded.items)) return null;
    const items: NotePdfOmission[] = [];
    for (const item of decoded.items) {
      if (!isObject(item) || typeof item.code !== "string" || typeof item.kind !== "string" || typeof item.label !== "string") return null;
      if (isCode(item.code) && isKind(item.kind)) items.push({ code: item.code, kind: item.kind, label: notePdfOmissionLabel(item.label) });
    }
    const more = typeof decoded.more === "number" && Number.isSafeInteger(decoded.more) && decoded.more >= 0 ? decoded.more : 0;
    return { items, more };
  } catch {
    return null;
  }
};
