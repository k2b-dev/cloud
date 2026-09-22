import { writeOds } from "hucre/ods";

// Parsing expands compressed data into XML/text and object graphs. This is a
// per-workbook working-set budget shared by the ODS/XLSX readers and the ODS
// writer, never a limit on the selected folder.
export const WORKBOOK_EXPANDED_BYTES = 128 * 1024 * 1024;
export const ODS_MEDIA_TYPE = "application/vnd.oasis.opendocument.spreadsheet";

/** Check total ZIP directory sizes before a reader allocates expanded XML. */
export function checkWorkbookArchive(buffer: ArrayBuffer, format: "XLSX" | "ODS", budget = WORKBOOK_EXPANDED_BYTES) {
  const view = new DataView(buffer);
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === view.byteLength) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`Expected an ${format} ZIP archive; XLS and XLSB are not supported`);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true),
    expanded = 0;
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 0xffff || offset === 0xffffffff)
    throw new Error("Multipart and ZIP64 workbooks are not supported");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error(`Invalid ${format} ZIP directory`);
    if (view.getUint16(offset + 8, true) & 1) throw new Error("Encrypted workbooks are not supported");
    expanded += view.getUint32(offset + 24, true);
    if (expanded > budget) throw new Error("Workbook exceeds the 128 MiB expanded XML budget");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  if (offset !== end) throw new Error(`Invalid ${format} ZIP directory length`);
}

export type OdsCell = string | number | boolean | Date | null | undefined;
export type OdsSheet = { name: string; rows: OdsCell[][] };

const SHEET_NAME_LENGTH = 31;
// Spreadsheet applications reject these in sheet names; the writer refuses them too.
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g;
// Roughly what one cell costs in content.xml on top of its text; a lower bound
// that fails obviously oversized workbooks before any XML is built.
const CELL_XML_BYTES = 48;

/** A sheet name every reader accepts: forbidden characters replaced, length bounded, unique per workbook. */
function sheetName(name: unknown, index: number, taken: Set<string>) {
  if (typeof name !== "string") throw new Error(`Sheet ${index + 1} needs a string name`);
  let base = name
    .replace(SHEET_NAME_FORBIDDEN, "_")
    .replace(/^'+|'+$/g, "")
    .trim()
    .slice(0, SHEET_NAME_LENGTH)
    .trim();
  if (!base || base.toLowerCase() === "history") base = `Sheet${index + 1}`;
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, SHEET_NAME_LENGTH - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Write sheets of plain cells as an ODS workbook. Cells are strings, finite
 * numbers, booleans, valid dates (second precision, UTC), or empty.
 */
export async function writeOdsWorkbook(sheets: OdsSheet[], maxExpandedBytes = WORKBOOK_EXPANDED_BYTES): Promise<Blob> {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("Expected at least one sheet");
  const taken = new Set<string>();
  let estimated = 0;
  const encoded = sheets.map((sheet, index) => {
    if (!sheet || typeof sheet !== "object" || !Array.isArray(sheet.rows)) throw new Error(`Sheet ${index + 1} needs a rows array`);
    const name = sheetName(sheet.name, index, taken);
    const rows = sheet.rows.map((row, r) => {
      if (!Array.isArray(row)) throw new Error(`${name} row ${r + 1} is not an array`);
      return row.map((cell, c) => {
        const where = `${name} row ${r + 1} column ${c + 1}`;
        if (cell === null || cell === undefined) {
          estimated += CELL_XML_BYTES;
          return null;
        }
        if (typeof cell === "string") estimated += CELL_XML_BYTES + cell.length;
        else if (typeof cell === "number") {
          if (!Number.isFinite(cell)) throw new Error(`${where}: number must be finite`);
          estimated += CELL_XML_BYTES + 24;
        } else if (typeof cell === "boolean") estimated += CELL_XML_BYTES;
        else if (cell instanceof Date) {
          if (Number.isNaN(cell.getTime())) throw new Error(`${where}: invalid date`);
          estimated += CELL_XML_BYTES + 40;
        } else throw new Error(`${where}: cells must be strings, numbers, booleans, dates, or null`);
        if (estimated > maxExpandedBytes) throw new Error("Workbook exceeds the 128 MiB expanded XML budget");
        return cell;
      });
    });
    return { name, rows };
  });
  // A copy owns a plain ArrayBuffer for the exact check and the Blob.
  const archive = (await writeOds({ sheets: encoded })).slice();
  // Exact check on the written archive so the result stays readable with `sheet.openOds`.
  checkWorkbookArchive(archive.buffer, "ODS", maxExpandedBytes);
  return new Blob([archive], { type: ODS_MEDIA_TYPE });
}
