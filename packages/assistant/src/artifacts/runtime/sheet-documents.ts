import { readOds } from "hucre/ods";
import readExcelFile from "read-excel-file/universal";
import { checkWorkbookArchive, WORKBOOK_EXPANDED_BYTES, writeOdsWorkbook } from "./workbook";
// Parsing expands compressed data into XML/text and object graphs. This is a
// per-document working-set budget, never a limit on the selected folder.
export const DOCUMENT_BYTES = 64 * 1024 * 1024;
function checkFile(file: Blob) {
  if (!(file instanceof Blob)) throw new Error("Expected a local File or Blob");
  if (file.size > DOCUMENT_BYTES)
    throw new Error("Document exceeds the 64 MiB per-file parsing budget. Split this document; other files can still be processed.");
}

export const excel = {
  async open(file: Blob, options: { numbers?: "number" | "string" } = {}) {
    checkFile(file);
    const bytes = await file.arrayBuffer();
    checkWorkbookArchive(bytes, "XLSX");
    // Parse once. Arrays preserve empty/duplicate headings and original row order.
    let sheets = await readExcelFile(
      bytes,
      options.numbers === "string" ? { trim: false, parseNumber: (value) => value } : { trim: false },
    );
    let closed = false;
    return {
      sheetNames: sheets.map((sheet) => sheet.sheet),
      readSheet(name: string) {
        if (closed) throw new Error("Workbook is closed");
        const sheet = sheets.find((sheet) => sheet.sheet === name);
        if (!sheet) throw new Error(`Sheet not found: ${name}`);
        return sheet.data;
      },
      close() {
        sheets = [];
        closed = true;
      },
    };
  },
};

export const ods = {
  async open(file: Blob) {
    checkFile(file);
    const bytes = await file.arrayBuffer();
    checkWorkbookArchive(bytes, "ODS");
    // Import only the ODS reader. Formulas remain cached values, never executable code.
    let sheets = (await readOds(bytes, { maxDecompressedBytes: WORKBOOK_EXPANDED_BYTES })).sheets.map(({ name, rows }) => ({ name, rows }));
    if (!sheets.length) throw new Error("ODS contains no worksheets");
    let closed = false;
    return {
      sheetNames: sheets.map((sheet) => sheet.name),
      readSheet(name: string) {
        if (closed) throw new Error("Workbook is closed");
        const sheet = sheets.find((sheet) => sheet.name === name);
        if (!sheet) throw new Error(`Sheet not found: ${name}`);
        return sheet.rows;
      },
      close() {
        sheets = [];
        closed = true;
      },
    };
  },
  write: writeOdsWorkbook,
};
