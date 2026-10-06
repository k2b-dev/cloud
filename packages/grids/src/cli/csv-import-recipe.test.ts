import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VALUE_FIELD_TYPES } from "../field-types";
import { parseGridsQueryDsl } from "../query-dsl/parser";

/** The CSV recipe in the agent reference is copied by agents as it stands, so it runs here as written. */
const reference = await Bun.file(new URL("../cli-references/index.md", import.meta.url)).text();
const section = reference.split("### Import a CSV file")[1]!.split("\n### ")[0]!;
const converter = section.match(/```ts\n(\/\/ csv-to-records\.ts[\s\S]*?)```/)![1]!;
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

type Column = string | { field: string; format: string };

const convert = async (csv: string | Uint8Array, columns: Record<string, Column>, delimiter?: string, dir?: string) => {
  if (!dir) {
    dir = await mkdtemp(join(tmpdir(), "grids-csv-recipe-"));
    dirs.push(dir);
  }
  await Bun.write(join(dir, "csv-to-records.ts"), converter);
  await Bun.write(join(dir, "data.csv"), csv);
  await Bun.write(join(dir, "columns.json"), JSON.stringify(columns));
  const run = Bun.spawnSync(["bun", "csv-to-records.ts", "data.csv", "columns.json", ...(delimiter ? [delimiter] : [])], {
    cwd: dir,
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  const files = (await readdir(dir)).filter((name) => name.startsWith("records-")).sort();
  const batches = await Promise.all(files.map((name) => Bun.file(join(dir, name)).json() as Promise<{ items: Record<string, string>[] }>));
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString(), files, batches };
};

test("the converter reads quoted, multiline, BOM, and CRLF cells and leaves empty cells out", async () => {
  const csv =
    '﻿Name , Email,Since,Active,Notes\r\n"Doe, Jane",jane@example.com,2026-10-05,true,"Says ""hi""\r\non two lines"\r\n\r\nBob,,2026-01-31,0,5" screen\r\n';
  const result = await convert(csv, { Name: "Name01", Email: "Mail01", Since: "Date01", Active: "Bool01", Notes: "Note01" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("records-001.json\n");
  expect(result.batches).toEqual([
    {
      items: [
        { Name01: "Doe, Jane", Mail01: "jane@example.com", Date01: "2026-10-05", Bool01: "true", Note01: 'Says "hi"\r\non two lines' },
        { Name01: "Bob", Date01: "2026-01-31", Bool01: "0", Note01: '5" screen' },
      ],
    },
  ]);
  // The documented field types accept the strings the converter writes.
  const types: Record<string, string> = { Name01: "text", Mail01: "text", Date01: "date", Bool01: "boolean", Note01: "longtext" };
  for (const item of result.batches[0]!.items) {
    for (const [fieldId, value] of Object.entries(item)) {
      expect(VALUE_FIELD_TYPES[types[fieldId]!]!.validate(value, {}, false).ok, `${fieldId}=${value}`).toBe(true);
    }
  }
  expect(VALUE_FIELD_TYPES.number!.validate("1234.50", {}, false).ok).toBe(true);
  expect(VALUE_FIELD_TYPES.number!.validate("1,5", {}, false).ok).toBe(false);
  expect(VALUE_FIELD_TYPES.date!.validate("05.10.2026", {}, false).ok).toBe(false);
});

test("the converter splits large files into batches of 500 and takes another delimiter", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => `Person ${index + 1};${index + 1}`);
  const result = await convert(["Name;Count", ...rows].join("\n"), { Name: "Name01", Count: "Num001" }, ";");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.files).toEqual(["records-001.json", "records-002.json"]);
  expect(result.batches.map((batch) => batch.items.length)).toEqual([500, 1]);
  expect(result.batches[1]!.items[0]).toEqual({ Name01: "Person 501", Num001: "501" });
});

test("the converter reads a quoted cell after a space", async () => {
  const result = await convert('Name,Company,City\nJane, "Doe, Inc" , Berlin\n', { Name: "Name01", Company: "Firm01", City: "City01" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.batches).toEqual([{ items: [{ Name01: "Jane", Firm01: "Doe, Inc", City01: "Berlin" }] }]);
});

// A subprocess converts half a million rows here, so this test gets the integration budget instead of the 5 s default.
test("the converter numbers batches so that the shell glob keeps their order past 999 files", async () => {
  const rows = Array.from({ length: 999 * 500 + 1 }, (_, index) => `P${index + 1}`);
  const result = await convert(["Name", ...rows].join("\n"), { Name: "Name01" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.files).toHaveLength(1000);
  expect(result.files.slice(0, 2)).toEqual(["records-0001.json", "records-0002.json"]);
  // `result.files` is sorted like the glob in the import loop, so each batch must start where the previous one ended.
  expect(result.batches.map((batch) => batch.items[0]!.Name01)).toEqual(Array.from({ length: 1000 }, (_, index) => `P${index * 500 + 1}`));
}, 30_000);

// A malformed file must stop the recipe before any batch exists, or `records import` stores shifted or merged rows.
test.each([
  ["a mapped column the CSV does not have", "Name\nJane\n", 'The CSV has no column "Email".'],
  ["an unclosed quote", 'Name,Email\n"Alice,alice@example.com\nBob,bob@example.com\n', "Row 2 opens a quote that is never closed."],
  ["a mapped header that occurs twice", "Name,Email,Name\nAlice,alice@example.com,Bob\n", 'The CSV has the column "Name" 2 times.'],
  [
    "a row with more cells than the header",
    "Name,Email\nJane,jane@example.com\n\nDoe, Jane,jane@example.com\n",
    "Row 4 has a different number of cells than the header: 3, not 2.",
  ],
  ["a row with fewer cells than the header", "Name,Email\nJane\n", "Row 2 has a different number of cells than the header: 1, not 2."],
])("the converter fails on %s and writes no file", async (_, csv, message) => {
  const result = await convert(csv, { Name: "Name01", Email: "Mail01" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.files).toEqual([]);
});

test("the converter rewrites decimal commas and dd.mm.yyyy dates into values the field types accept", async () => {
  const csv = "Name;Fee;Since\nAda;1.234,50;05.10.2026\nBob;-7;1.2.2026\nCy;1234;29.02.2028\nDi;0,5;\nEd;0;05.10.0099\n";
  const columns = { Name: "Name01", Fee: { field: "Fee001", format: "decimal-comma" }, Since: { field: "Date01", format: "dd.mm.yyyy" } };
  const result = await convert(csv, columns, ";");
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.batches).toEqual([
    {
      items: [
        { Name01: "Ada", Fee001: "1234.50", Date01: "2026-10-05" },
        { Name01: "Bob", Fee001: "-7", Date01: "2026-02-01" },
        { Name01: "Cy", Fee001: "1234", Date01: "2028-02-29" },
        { Name01: "Di", Fee001: "0.5" },
        { Name01: "Ed", Fee001: "0", Date01: "0099-10-05" },
      ],
    },
  ]);
  for (const item of result.batches[0]!.items) {
    expect(VALUE_FIELD_TYPES.number!.validate(item.Fee001, {}, false).ok, item.Fee001).toBe(true);
    if (item.Date01) expect(VALUE_FIELD_TYPES.date!.validate(item.Date01, {}, false).ok, item.Date01).toBe(true);
  }
});

test.each([
  ["a currency sign", "Fee\n1.234,50 €\n", 'Row 2, column "Fee": "1.234,50 €" does not match the format decimal-comma.'],
  ["a decimal point in a decimal-comma column", "Fee\n12.5\n", 'Row 2, column "Fee": "12.5" does not match the format decimal-comma.'],
  ["a day that does not exist", "Since\n31.02.2026\n", 'Row 2, column "Since": "31.02.2026" does not match the format dd.mm.yyyy.'],
  [
    "an ISO date in a dd.mm.yyyy column",
    "Since\n2026-10-05\n",
    'Row 2, column "Since": "2026-10-05" does not match the format dd.mm.yyyy.',
  ],
])("the converter fails on %s and writes no file", async (_, csv, message) => {
  const header = csv.split("\n")[0]!;
  const format = header === "Fee" ? "decimal-comma" : "dd.mm.yyyy";
  const result = await convert(csv, { [header]: { field: "Fld001", format } }, ";");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.files).toEqual([]);
});

// toString is inherited by every object, so only the converter's own formats count.
test.each(["german", "toString"])("the converter rejects the unknown format %s before it writes a file", async (format) => {
  const result = await convert("Fee\n1,5\n", { Fee: { field: "Fee001", format } }, ";");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(`Column "Fee" has the unknown format "${format}".`);
  expect(result.files).toEqual([]);
});

test("the converter skips unmapped headers that name inherited object keys", async () => {
  const result = await convert("Name,constructor,toString,__proto__\nAda,a,b,c\n", { Name: "Name01" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.batches).toEqual([{ items: [{ Name01: "Ada" }] }]);
});

test("the converter reports a missing CSV file as missing, not as an encoding problem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grids-csv-recipe-"));
  dirs.push(dir);
  await Bun.write(join(dir, "csv-to-records.ts"), converter);
  await Bun.write(join(dir, "columns.json"), "{}");
  const run = Bun.spawnSync(["bun", "csv-to-records.ts", "missing.csv", "columns.json"], {
    cwd: dir,
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("ENOENT");
  expect(run.stderr.toString()).not.toContain("not UTF-8");
});

test("the converter refuses a Windows-1252 file, and the documented iconv command makes it readable", async () => {
  // "Jürgen;Köln;1.234,50" with ü, ö as single Windows-1252 bytes.
  const latin = new Uint8Array([
    ...new TextEncoder().encode("Name;City;Fee\nJ"),
    0xfc,
    ...new TextEncoder().encode("rgen;K"),
    0xf6,
    ...new TextEncoder().encode("ln;1.234,50\n"),
  ]);
  const columns = { Name: "Name01", City: "City01", Fee: { field: "Fee001", format: "decimal-comma" } };
  const refused = await convert(latin, columns, ";");
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toContain("data.csv is not UTF-8. Convert it first: iconv -f WINDOWS-1252 -t UTF-8 data.csv > data-utf8.csv");
  expect(refused.files).toEqual([]);

  const dir = await mkdtemp(join(tmpdir(), "grids-csv-recipe-"));
  dirs.push(dir);
  await Bun.write(join(dir, "latin.csv"), latin);
  const command = section.match(/`(iconv -f WINDOWS-1252 -t UTF-8 data\.csv > data-utf8\.csv)`/)![1]!.replace("data.csv", "latin.csv");
  const iconv = Bun.spawnSync(["sh", "-c", command], { cwd: dir });
  expect(iconv.exitCode, iconv.stderr.toString()).toBe(0);
  const converted = await convert(await Bun.file(join(dir, "data-utf8.csv")).bytes(), columns, ";", dir);
  expect(converted.exitCode, converted.stderr).toBe(0);
  expect(converted.batches).toEqual([{ items: [{ Name01: "Jürgen", City01: "Köln", Fee001: "1234.50" }] }]);
});

test("the converter ignores a repeated header it does not map", async () => {
  const result = await convert("Name,Notes,Notes\nJane,a,b\n", { Name: "Name01" });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.batches).toEqual([{ items: [{ Name01: "Jane" }] }]);
});

test("the CSV recipe and the first-rows queries use real commands and valid GQL", () => {
  expect(JSON.parse(section.match(/```json\n([\s\S]*?)```/)![1]!)).toBeObject();
  const queries = [...reference.matchAll(/gql run \S+ --query '([^']+)'/g)].map((match) => match[1]!);
  expect(queries.length).toBeGreaterThanOrEqual(2);
  for (const query of queries) expect(parseGridsQueryDsl(query).ok, query).toBe(true);
});
