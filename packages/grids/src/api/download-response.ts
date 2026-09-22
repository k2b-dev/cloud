export const encodeHeaderValue = (value: string): string =>
  encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const contentDispositionFilename = (disposition: "attachment" | "inline", filename: string): string => {
  const safeFilename =
    filename
      .replace(/[\r\n]/g, " ")
      .replace(/[/:*?"<>|\\]/g, "-")
      .replace(/\s+/g, " ")
      .trim() || "document";
  const fallback =
    safeFilename
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\r\n"\\]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .trim() || "document";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(safeFilename)}`;
};

/** Stored content read in bounded slices; the length is known up front. */
export type StreamedFileBody = { stream: () => ReadableStream<Uint8Array>; sizeBytes: number };

export const fileResponse = (
  body: Uint8Array | StreamedFileBody,
  filename: string,
  contentType: string,
  headers: Record<string, string> = {},
  disposition: "attachment" | "inline" = "attachment",
) =>
  new Response(body instanceof Uint8Array ? new Blob([Uint8Array.from(body)], { type: contentType }) : body.stream(), {
    headers: {
      "Content-Type": contentType,
      ...(body instanceof Uint8Array ? {} : { "Content-Length": String(body.sizeBytes) }),
      "Content-Disposition": contentDispositionFilename(disposition, filename),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });

export const pdfResponse = (
  pdf: Uint8Array,
  filename: string,
  headers: Record<string, string> = {},
  disposition: "attachment" | "inline" = "attachment",
) => fileResponse(pdf, filename, "application/pdf", headers, disposition);
