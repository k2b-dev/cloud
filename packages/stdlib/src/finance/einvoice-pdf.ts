import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { ok } from "../result";
import { invalid, type FinanceResult } from "./common";
import type { InvoiceParseOptions } from "./einvoice-contracts";

/** Read document attachments, including recursive name trees and associated files. */
export async function extractInvoiceXml(bytes: Uint8Array, options: InvoiceParseOptions): Promise<FinanceResult<{ xml: string; filename: string }>> {
  const maxCharacters = options.maxCharacters ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > Math.floor(Number.MAX_SAFE_INTEGER / 4)) return invalid([{ code: "invalid_input", path: ["options", "maxCharacters"], message: "Invalid character limit." }]);
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    const files = new Set<PDFDict>();
    const visited = new Set<PDFDict>();
    const collect = (array: PDFArray | undefined) => {
      if (!array) return;
      for (let index = 0; index < array.size(); index++) {
        const item = array.lookup(index);
        if (item instanceof PDFDict) files.add(item);
      }
    };
    const walk = (node: PDFDict, depth: number) => {
      if (visited.has(node)) throw new Error("Cyclic name tree.");
      if (depth > 64 || visited.size >= 10_000) throw new Error("Name tree limit exceeded.");
      visited.add(node);
      collect(node.lookupMaybe(PDFName.of("Names"), PDFArray));
      const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
      if (kids) for (let index = 0; index < kids.size(); index++) walk(kids.lookup(index, PDFDict), depth + 1);
    };
    const names = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    const embedded = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
    if (embedded) walk(embedded, 0);
    collect(pdf.catalog.lookupMaybe(PDFName.of("AF"), PDFArray));
    const candidates: { filename: string; stream: PDFRawStream }[] = [];
    for (const file of files) {
      const name = file.lookup(PDFName.of("UF")) ?? file.lookup(PDFName.of("F"));
      if (!(name instanceof PDFString || name instanceof PDFHexString)) continue;
      const filename = name.decodeText();
      if (!["factur-x.xml", "zugferd-invoice.xml", "xrechnung.xml"].includes(filename.toLowerCase())) continue;
      const ef = file.lookupMaybe(PDFName.of("EF"), PDFDict);
      const stream = ef?.lookup(PDFName.of("UF")) ?? ef?.lookup(PDFName.of("F"));
      if (!(stream instanceof PDFRawStream)) throw new Error("Missing attachment stream.");
      candidates.push({ filename, stream });
    }
    if (candidates.length !== 1) return invalid([{ code: "unsupported_format", path: ["pdf"], message: "Expected exactly one recognised invoice XML attachment." }]);
    const candidate = candidates[0]!;
    // Read only enough decoded bytes for the XML budget (UTF-8 uses at most four per character).
    const data = decodePDFRawStream(candidate.stream).getBytes(maxCharacters * 4 + 1);
    if (data.length > maxCharacters * 4) return invalid([{ code: "input_limit", path: ["pdf"], message: "Embedded XML exceeds byte limit." }]);
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (xml.length > maxCharacters) return invalid([{ code: "input_limit", path: ["xml"], message: "Embedded XML exceeds maxCharacters." }]);
    return ok({ xml, filename: candidate.filename });
  } catch {
    return invalid([{ code: "invalid_input", path: ["pdf"], message: "Cannot read invoice attachment from PDF. Encrypted, malformed or unsupported PDFs are rejected." }]);
  }
}
