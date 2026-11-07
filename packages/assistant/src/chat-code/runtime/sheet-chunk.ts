import { CloudError, guarded } from "./errors";
import { excel, ods } from "./sheet-documents";
import type { OdsSheet } from "./workbook";

export const toOds = (sheets: OdsSheet[]) => ods.write(sheets);
export async function read(file: Blob, options: { numbers?: "number" | "string" } = {}) {
  if (!(file instanceof Blob)) throw new CloudError("invalid", "Expected a spreadsheet File or Blob.");
  if (file.size > 64 * 1024 * 1024) throw new CloudError("limit", "Spreadsheet exceeds the 64 MiB parsing budget; split the document.");
  const bytes = await file.arrayBuffer();
  // Inspect only the bounded ZIP directory, before either reader expands the workbook.
  const { checkWorkbookArchive } = await import("./workbook");
  const names = checkWorkbookArchive(bytes, "XLSX");
  const isOds = names.has("content.xml") && !names.has("xl/workbook.xml");
  const workbook = isOds ? await ods.open(file) : await excel.open(file, options);
  return {
    sheetNames: workbook.sheetNames,
    rows: guarded((name = workbook.sheetNames[0]!) => {
      const rows = workbook.readSheet(name);
      return isOds && options.numbers === "string"
        ? rows.map((row) => row.map((cell) => (typeof cell === "number" ? String(cell) : cell)))
        : rows;
    }),
  };
}
