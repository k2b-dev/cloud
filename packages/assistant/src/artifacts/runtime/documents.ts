import readExcelFile from "read-excel-file/universal";
import { getDocument } from "pdfjs-dist";
// Registers the bundled handler used by PDF.js's in-process transport. This
// module already runs inside the isolated, terminable application worker.
import "pdfjs-dist/build/pdf.worker.mjs";

// Parsing expands compressed data into XML/text and object graphs. These are
// per-document working-set budgets, never a limit on the selected folder.
export const DOCUMENT_BYTES = 64 * 1024 * 1024;
export const XLSX_EXPANDED_BYTES = 128 * 1024 * 1024;
function checkFile(file: Blob) {
  if (!(file instanceof Blob)) throw new Error("Expected a local File or Blob");
  if (file.size > DOCUMENT_BYTES) throw new Error("Document exceeds the 64 MiB per-file parsing budget. Split this document; other files can still be processed.");
}

/** Check ZIP directory sizes before the XLSX library allocates expanded XML. */
export function checkXlsxArchive(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) { end = i; break; }
  }
  if (end < 0) throw new Error("Expected an XLSX ZIP archive; XLS and XLSB are not supported");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true), expanded = 0;
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 0xffff || offset === 0xffffffff)
    throw new Error("Multipart and ZIP64 workbooks are not supported");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid XLSX ZIP directory");
    if (view.getUint16(offset + 8, true) & 1) throw new Error("Encrypted workbooks are not supported");
    expanded += view.getUint32(offset + 24, true);
    if (expanded > XLSX_EXPANDED_BYTES) throw new Error("Workbook exceeds the 128 MiB expanded XML budget");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== end) throw new Error("Invalid XLSX ZIP directory length");
}

export const excel = {
  async open(file: Blob, options: { numbers?: "number" | "string" } = {}) {
    checkFile(file);
    const bytes = await file.arrayBuffer();
    checkXlsxArchive(bytes);
    // Parse once. Arrays preserve empty/duplicate headings and original row order.
    let sheets = await readExcelFile(bytes, options.numbers === "string" ? { trim: false, parseNumber: value => value } : { trim: false });
    let closed = false;
    return {
      sheetNames: sheets.map(sheet => sheet.sheet),
      readSheet(name: string) {
        if (closed) throw new Error("Workbook is closed");
        const sheet = sheets.find(sheet => sheet.sheet === name);
        if (!sheet) throw new Error(`Sheet not found: ${name}`);
        return sheet.data;
      },
      close() { sheets = []; closed = true; },
    };
  },
};

export const pdf = {
  async open(file: Blob) {
    checkFile(file);
    const task = getDocument({ verbosity: 0, data: new Uint8Array(await file.arrayBuffer()),
      useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false, stopAtErrors: true });
    try {
      const document = await task.promise;
      let closed = false;
      return {
        pageCount: document.numPages,
        async readPage(number: number) {
          if (closed) throw new Error("PDF is closed");
          if (!Number.isInteger(number) || number < 1 || number > document.numPages) throw new Error("PDF page number is out of range (pages start at 1)");
          const page = await document.getPage(number);
          try {
            const content = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1 });
            const items = content.items.flatMap(item => "str" in item ? [{ text: item.str, transform: item.transform,
              width: item.width, height: item.height, direction: item.dir, endOfLine: item.hasEOL }] : []);
            return { page: number, width: viewport.width, height: viewport.height,
              text: items.map(item => item.text + (item.endOfLine ? "\n" : " ")).join(""), items };
          } finally { page.cleanup(); }
        },
        async close() { closed = true; await task.destroy(); },
      };
    } catch (error) { await task.destroy(); throw error; }
  },
};
