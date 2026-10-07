import { expect, test } from "bun:test";
import { read, toOds } from "./sheet-chunk";

const fixture = async (name: string) =>
  new Blob([await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer()], { type: "application/octet-stream" });

test("sheet.read detects XLSX and ODS bytes and defaults rows to the first sheet", async () => {
  for (const name of ["ledger.xlsx", "ledger.ods"]) {
    const workbook = await read(await fixture(name), { numbers: "string" });
    expect(workbook.sheetNames[0]).toBe("Ledger");
    expect(workbook.rows()).toEqual(workbook.rows("Ledger"));
    expect(workbook.rows()[1]?.[1]).toBe("12.34");
    expect(() => workbook.rows("Missing")).toThrow("Sheet not found: Missing");
  }
});
test("ODS exports round-trip typed cells through automatic format detection", async () => {
  const file = await toOds([
    {
      name: "Results",
      rows: [
        ["Amount", "Paid"],
        [12.5, true],
      ],
    },
  ]);
  expect((await read(file)).rows()).toEqual([
    ["Amount", "Paid"],
    [12.5, true],
  ]);
  await expect(read(new Blob(["not a spreadsheet"]))).rejects.toThrow("ZIP archive");
});
