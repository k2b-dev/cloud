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

const convert = async (csv: string, columns: Record<string, string>, delimiter?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "grids-csv-recipe-"));
  dirs.push(dir);
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

test("the converter fails on a mapped column the CSV does not have", async () => {
  const result = await convert("Name\nJane\n", { Name: "Name01", Email: "Mail01" });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('The CSV has no column "Email".');
  expect(result.files).toEqual([]);
});

test("the CSV recipe and the first-rows queries use real commands and valid GQL", () => {
  expect(JSON.parse(section.match(/```json\n([\s\S]*?)```/)![1]!)).toBeObject();
  const queries = [...reference.matchAll(/gql run \S+ --query '([^']+)'/g)].map((match) => match[1]!);
  expect(queries.length).toBeGreaterThanOrEqual(2);
  for (const query of queries) expect(parseGridsQueryDsl(query).ok, query).toBe(true);
});
