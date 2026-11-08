import { crc32 } from "node:zlib";
import {
  type GotenbergConfig,
  GotenbergRenderError,
  getGotenbergConfig,
  mergePdfsWithConfig,
  type RenderHtmlToPdfOptions,
  requestGotenberg,
} from "./gotenberg";

export type PdfToolOperation =
  | { kind: "merge" }
  | { kind: "extract"; pages: number[] }
  | { kind: "split"; groups: number[][] }
  | { kind: "rotate"; angle: 90 | 180 | 270; pages?: number[] }
  | { kind: "reorder"; pages: number[] };

export type PdfToolInput = { files: Blob[]; operation: PdfToolOperation };
export type PdfToolResult = { data: Uint8Array } & (
  | { contentType: "application/pdf"; extension: "pdf" }
  | { contentType: "application/zip"; extension: "zip" }
);

// Same multipart envelope as document uploads. Reserve it per file before parsing.
export const PDF_TOOL_PART_METADATA_BYTES = 8 * 1024;
// The existing Gotenberg setting's minimum deadline is one work unit, not an
// estimate of renderer speed. The whole operation still has ONE real deadline.
const MIN_RENDER_TIMEOUT_MS = 100;

export const pdfToolLimits = (config: GotenbergConfig) => {
  if (
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < MIN_RENDER_TIMEOUT_MS ||
    config.timeoutMs > 120_000 ||
    !Number.isSafeInteger(config.maxPdfBytes) ||
    config.maxPdfBytes < 1024 ||
    config.maxPdfBytes > 104_857_600 ||
    !Number.isSafeInteger(config.maxHtmlBytes) ||
    config.maxHtmlBytes < 1024 ||
    config.maxHtmlBytes > 10_485_760
  )
    throw new GotenbergRenderError("not_configured", "PDF limits are invalid.");
  const maxOperations = Math.max(2, Math.floor(config.timeoutMs / MIN_RENDER_TIMEOUT_MS));
  const metadataSlots = Math.max(1, Math.floor(config.maxHtmlBytes / PDF_TOOL_PART_METADATA_BYTES));
  return {
    maxFiles: Math.min(metadataSlots, maxOperations - 1),
    // Reserve inspection and the final merge even for one run per page.
    maxPages: Math.min(metadataSlots, Math.max(1, maxOperations - 2)),
    maxOperations,
    maxInputBytes: config.maxPdfBytes,
    maxRequestBytes: config.maxPdfBytes + config.maxHtmlBytes,
    maxMetadataBytes: config.maxHtmlBytes,
    // Two-phase baseline: inspect the input, then transform it. Reorder and
    // split spend this SAME allowance, rather than multiplying it per call.
    maxWorkBytes: 2 * config.maxPdfBytes,
  };
};

const invalid = (message: string): never => {
  throw new GotenbergRenderError("bad_input", message);
};
const tooLarge = (): never => {
  throw new GotenbergRenderError("pdf_too_large", "PDF operation exceeds the configured work budget.");
};
const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 && bytes[0] === 37 && bytes[1] === 80 && bytes[2] === 68 && bytes[3] === 70 && bytes[4] === 45;

/** Validate shape/counts before file reads, renderer admission or allocation. */
export function validatePdfToolInput(input: PdfToolInput, config: GotenbergConfig): void {
  const limits = pdfToolLimits(config);
  if (!input.files.length || input.files.length > limits.maxFiles) invalid("Invalid PDF file count.");
  if (input.operation.kind !== "merge" && input.files.length !== 1) invalid("This operation requires exactly one PDF.");
  let total = 0;
  for (const file of input.files) {
    if (!(file instanceof Blob) || file.size < 5 || (file.type && file.type !== "application/pdf")) invalid("Upload PDF files only.");
    total += file.size;
    if (total > limits.maxInputBytes) tooLarge();
  }
  const checkPages = (pages: number[], ascending: boolean) => {
    if (!pages.length || pages.length > limits.maxPages || pages.some((p) => !Number.isSafeInteger(p) || p < 1 || p > limits.maxPages))
      invalid("Invalid page selection.");
    if (new Set(pages).size !== pages.length || (ascending && pages.some((p, i) => i > 0 && p <= pages[i - 1]!)))
      invalid("Choose distinct pages in source order; use reorder to change their order.");
  };
  switch (input.operation.kind) {
    case "merge":
      break;
    case "extract":
      checkPages(input.operation.pages, true);
      break;
    case "reorder":
      checkPages(input.operation.pages, false);
      break;
    case "rotate":
      if (![90, 180, 270].includes(input.operation.angle)) invalid("Invalid rotation angle.");
      if (input.operation.pages) checkPages(input.operation.pages, true);
      break;
    case "split": {
      const { groups } = input.operation;
      if (groups.length < 2 || groups.length > limits.maxPages) invalid("Choose at least two bounded page groups.");
      let selected = 0;
      for (const group of groups) {
        selected += group.length;
        if (selected > limits.maxPages) invalid("Too many selected pages.");
        checkPages(group, true);
      }
      const pages = groups.flat();
      checkPages(pages, false);
      break;
    }
    default:
      invalid("Unknown PDF operation.");
  }
  if (new TextEncoder().encode(JSON.stringify(input.operation)).length > limits.maxMetadataBytes) tooLarge();
}

const pdfForm = (files: Blob[]) => {
  const form = new FormData();
  files.forEach((file, i) => form.append("files", file, `${String(i + 1).padStart(6, "0")}.pdf`));
  return form;
};

/** Stored ZIP: no decompression, temporary files, or additional codec work. */
function zipParts(parts: Uint8Array[], maxBytes: number, signal: AbortSignal): Uint8Array {
  const entries = parts.map((data, i) => ({ data, name: new TextEncoder().encode(`part-${String(i + 1).padStart(6, "0")}.pdf`) }));
  const size = 22 + entries.reduce((sum, e) => sum + e.data.length + 76 + 2 * e.name.length, 0);
  if (size > maxBytes) tooLarge();
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  const offsets: number[] = [];
  const checksums: number[] = [];
  let pos = 0;
  entries.forEach(({ data, name }) => {
    signal.throwIfAborted();
    offsets.push(pos);
    const checksum = crc32(data);
    checksums.push(checksum);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 12, 33, true); // 1980-01-01; no wall-clock metadata.
    view.setUint32(pos + 14, checksum, true);
    view.setUint32(pos + 18, data.length, true);
    view.setUint32(pos + 22, data.length, true);
    view.setUint16(pos + 26, name.length, true);
    result.set(name, pos + 30);
    result.set(data, pos + 30 + name.length);
    pos += 30 + name.length + data.length;
  });
  const central = pos;
  entries.forEach(({ data, name }, i) => {
    signal.throwIfAborted();
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true);
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 14, 33, true);
    view.setUint32(pos + 16, checksums[i]!, true);
    view.setUint32(pos + 20, data.length, true);
    view.setUint32(pos + 24, data.length, true);
    view.setUint16(pos + 28, name.length, true);
    view.setUint32(pos + 42, offsets[i]!, true);
    result.set(name, pos + 46);
    pos += 46 + name.length;
  });
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 8, entries.length, true);
  view.setUint16(pos + 10, entries.length, true);
  view.setUint32(pos + 12, pos - central, true);
  view.setUint32(pos + 16, central, true);
  return result;
}

/**
 * Gotenberg 8.36/pdfcpu 0.15 trims a page set in source order, not span order.
 * https://github.com/gotenberg/gotenberg/blob/v8.36.0/pkg/modules/pdfcpu/pdfcpu.go
 * https://github.com/pdfcpu/pdfcpu/blob/v0.15.0/pkg/api/trim.go
 */
export async function runPdfToolWithConfig(
  input: PdfToolInput,
  config: GotenbergConfig,
  options: RenderHtmlToPdfOptions = {},
): Promise<PdfToolResult> {
  validatePdfToolInput(input, config);
  const limits = pdfToolLimits(config);
  const signal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const transport = { ...options, signal };
  let uploaded = 0;
  let downloaded = 0;
  let operations = 0;
  const reserve = (files: readonly { size: number }[]) => {
    signal.throwIfAborted();
    if (++operations > limits.maxOperations) tooLarge();
    uploaded += files.reduce((sum, file) => sum + file.size, 0);
    if (uploaded > limits.maxWorkBytes) tooLarge();
  };
  const send = async (route: string, files: Blob[], fields: Record<string, string> = {}, metadata = false) => {
    reserve(files);
    const form = pdfForm(files);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const remaining = metadata ? limits.maxMetadataBytes : Math.min(config.maxPdfBytes, limits.maxWorkBytes - downloaded);
    if (remaining < 1) tooLarge();
    const result = await requestGotenberg(route, form, { ...config, maxPdfBytes: remaining }, transport, [
      metadata ? "application/json" : "application/pdf",
    ]);
    if (!metadata) {
      downloaded += result.pdf.length;
      if (!isPdf(result.pdf)) throw new GotenbergRenderError("bad_response", "Renderer returned an invalid PDF.");
    }
    return result.pdf;
  };
  try {
    // Validate every magic prefix before transmitting any confidential data.
    for (const file of input.files) {
      signal.throwIfAborted();
      if (!isPdf(new Uint8Array(await file.slice(0, 5).arrayBuffer()))) invalid("Upload PDF files only.");
    }
    const metadataBytes = await send("/forms/pdfengines/metadata/read", input.files, {}, true);
    let counts: number[];
    try {
      const metadata: unknown = JSON.parse(new TextDecoder().decode(metadataBytes));
      if (!metadata || typeof metadata !== "object") throw new Error();
      counts = input.files.map((_, i) => {
        const entry: unknown = Reflect.get(metadata, `${String(i + 1).padStart(6, "0")}.pdf`);
        const count: unknown = entry && typeof entry === "object" ? Reflect.get(entry, "PageCount") : undefined;
        // Match ExifTool's documented number/string PageCount contract.
        const value = typeof count === "string" && /^\d+$/.test(count) ? Number(count) : count;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error();
        return value;
      });
    } catch {
      throw new GotenbergRenderError("unreadable_pdf", "Renderer did not provide valid PDF page counts.");
    }
    const totalPages = counts.reduce((sum, count) => sum + count, 0);
    if (totalPages > limits.maxPages) tooLarge();
    const operation = input.operation;
    if (operation.kind !== "merge") {
      const selected = operation.kind === "split" ? operation.groups.flat() : operation.pages;
      if (selected?.some((page) => page > counts[0]!)) invalid("A selected page does not exist.");
      if (operation.kind === "reorder" && operation.pages.length !== counts[0]) invalid("Reorder must include every page exactly once.");
    }
    let data: Uint8Array;
    if (operation.kind === "merge") {
      reserve(input.files);
      const result = await mergePdfsWithConfig(
        { files: await Promise.all(input.files.map(async (file) => ({ pdf: new Uint8Array(await file.arrayBuffer()) }))) },
        config,
        transport,
      );
      data = result.pdf;
      if (!isPdf(data)) throw new GotenbergRenderError("bad_response", "Renderer returned an invalid PDF.");
    } else if (operation.kind === "rotate") {
      data = await send("/forms/pdfengines/rotate", input.files, {
        rotateAngle: String(operation.angle),
        ...(operation.pages ? { rotatePages: operation.pages.join(",") } : {}),
      });
    } else {
      const extract = (pages: number[]) =>
        send("/forms/pdfengines/split", input.files, { splitMode: "pages", splitSpan: pages.join(","), splitUnify: "true" });
      if (operation.kind === "extract") data = await extract(operation.pages);
      else {
        const groups: number[][] = [];
        if (operation.kind === "split") groups.push(...operation.groups);
        else
          for (const page of operation.pages) {
            const last = groups.at(-1);
            if (last && page > last.at(-1)!) last.push(page);
            else groups.push([page]);
          }
        const expectedCalls = groups.length + (operation.kind === "reorder" && groups.length > 1 ? 1 : 0);
        if (operations + expectedCalls > limits.maxOperations || uploaded + input.files[0]!.size * groups.length > limits.maxWorkBytes)
          tooLarge();
        const parts: Uint8Array[] = [];
        let retained = 0;
        for (const group of groups) {
          const part = await extract(group);
          retained += part.length;
          if (retained > config.maxPdfBytes) tooLarge();
          parts.push(part);
        }
        if (operation.kind === "split") {
          data = zipParts(parts, config.maxPdfBytes, signal);
          if (downloaded + data.length > limits.maxWorkBytes) tooLarge();
          return { data, contentType: "application/zip", extension: "zip" };
        }
        if (parts.length === 1) data = parts[0]!;
        else {
          reserve(parts.map((part) => ({ size: part.length })));
          const merged = await mergePdfsWithConfig(
            { files: parts.map((pdf) => ({ pdf })) },
            { ...config, maxPdfBytes: Math.min(config.maxPdfBytes, limits.maxWorkBytes - downloaded) },
            transport,
          );
          data = merged.pdf;
          if (!isPdf(data)) throw new GotenbergRenderError("bad_response", "Renderer returned an invalid PDF.");
        }
      }
    }
    signal.throwIfAborted();
    return { data, contentType: "application/pdf", extension: "pdf" };
  } catch (error) {
    if (signal.aborted) throw new GotenbergRenderError("timeout", "PDF operation was cancelled or exceeded its deadline.");
    throw error;
  }
}

export const runPdfTool = async (input: PdfToolInput, options: RenderHtmlToPdfOptions = {}): Promise<PdfToolResult> =>
  runPdfToolWithConfig(input, await getGotenbergConfig(), options);
