import { describe, expect, test } from "bun:test";
import { readOds } from "hucre/ods";
import { ODS_MEDIA_TYPE, writeOdsWorkbook } from "./workbook";

const read = async (blob: Blob) => (await readOds(await blob.arrayBuffer())).sheets.map(({ name, rows }) => ({ name, rows }));

describe("writeOdsWorkbook", () => {
  test("round-trips typed cells through the reader", async () => {
    const date = new Date("2026-09-20T13:45:10Z");
    const blob = await writeOdsWorkbook([
      {
        name: "Ledger",
        rows: [
          ["Reference", "Amount", "Paid", "Date", "Note"],
          ["Müller & Söhne <AG>", 12.34, true, date, null],
          ["Line 1\nLine 2", -7, false, undefined, ""],
          [],
        ],
      },
      { name: "Empty", rows: [] },
    ]);
    expect(blob.type).toBe(ODS_MEDIA_TYPE);
    expect(await read(blob)).toEqual([
      {
        name: "Ledger",
        rows: [
          ["Reference", "Amount", "Paid", "Date", "Note"],
          // The reader omits trailing empty cells.
          ["Müller & Söhne <AG>", 12.34, true, date],
          ["Line 1\nLine 2", -7, false, null, ""],
        ],
      },
      { name: "Empty", rows: [] },
    ]);
  });

  test("stores the mimetype as the first, uncompressed entry", async () => {
    const bytes = new Uint8Array(await (await writeOdsWorkbook([{ name: "S", rows: [[1]] }])).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // compression method: stored
    const nameLength = view.getUint16(26, true);
    const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
    expect(name).toBe("mimetype");
    expect(new TextDecoder().decode(bytes.subarray(30 + nameLength, 30 + nameLength + ODS_MEDIA_TYPE.length))).toBe(ODS_MEDIA_TYPE);
  });

  test("sanitizes sheet names so every reader accepts the workbook", async () => {
    const sheets = await read(
      await writeOdsWorkbook([
        { name: "Q1/Q2: [Sales]*?\\", rows: [] },
        { name: "", rows: [] },
        { name: "'Quoted'", rows: [] },
        { name: "History", rows: [] },
        { name: "Quoted", rows: [] },
        { name: "quoted", rows: [] },
        { name: "A".repeat(40), rows: [] },
        { name: "a".repeat(40), rows: [] },
      ]),
    );
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "Q1_Q2_ _Sales____",
      "Sheet2",
      "Quoted",
      "Sheet4",
      "Quoted (2)",
      "quoted (3)",
      "A".repeat(31),
      `${"a".repeat(27)} (2)`,
    ]);
    await expect(writeOdsWorkbook([{ name: 3 as unknown as string, rows: [] }])).rejects.toThrow("Sheet 1 needs a string name");
  });

  test("rejects unsupported cells with their position", async () => {
    await expect(writeOdsWorkbook([{ name: "S", rows: [[1], ["a", { formula: "=1" } as unknown as string]] }])).rejects.toThrow(
      "S row 2 column 2: cells must be strings, numbers, booleans, dates, or null",
    );
    await expect(writeOdsWorkbook([{ name: "S", rows: [[Number.NaN]] }])).rejects.toThrow("S row 1 column 1: number must be finite");
    await expect(writeOdsWorkbook([{ name: "S", rows: [[new Date("nope")]] }])).rejects.toThrow("S row 1 column 1: invalid date");
    await expect(writeOdsWorkbook([])).rejects.toThrow("Expected at least one sheet");
    await expect(writeOdsWorkbook([{ name: "S", rows: "x" as unknown as never[] }])).rejects.toThrow("Sheet 1 needs a rows array");
  });

  test("fails clearly beyond the expanded workbook budget", async () => {
    const small = [{ name: "S", rows: [["x".repeat(2000)]] }];
    await expect(writeOdsWorkbook(small, 1024)).rejects.toThrow("128 MiB expanded XML budget");
    // Cells under the estimate but over the written XML still fail on the exact check.
    const many = [{ name: "S", rows: Array.from({ length: 100 }, () => Array.from({ length: 10 }, (_, i) => i)) }];
    await expect(writeOdsWorkbook(many, 20_000)).rejects.toThrow("128 MiB expanded XML budget");
    await expect(writeOdsWorkbook(many)).resolves.toBeInstanceOf(Blob);
  });
});
