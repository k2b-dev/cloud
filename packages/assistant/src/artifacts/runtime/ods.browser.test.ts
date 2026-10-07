import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type {} from "./browser-harness";
import { ChunkName, chunkSource } from "./chunks";
import { compileArtifact } from "./compile";

test("ODS reads typed cells, grouped rows and cached formulas and writes workbooks in the isolated worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-ods-test-"));
  let harness: string;
  try {
    const output = join(directory, "harness.js");
    const build = Bun.spawn(
      [
        "bun",
        "build",
        new URL("./browser-harness.ts", import.meta.url).pathname,
        "--target",
        "browser",
        "--format",
        "iife",
        "--outfile",
        output,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (await build.exited) throw new Error(await new Response(build.stderr).text());
    harness = await Bun.file(output).text();
  } finally {
    await rm(directory, { recursive: true });
  }
  const fixture = async (name: string) =>
    Buffer.from(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).arrayBuffer()).toString("base64");
  const source = await compileArtifact({
    entry: "main.js",
    files: [
      {
        path: "main.js",
        content: `
    export default async (_input, {files,signal,progress}) => {
      const blob = b64 => new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))]);
      const input = blob(${JSON.stringify(await fixture("ledger.ods"))});
      const workbook = await cloud.sheet.read(input);
      const names = workbook.sheetNames;
      const ledger = workbook.rows("Ledger");
      const types = workbook.rows("Types").map(row => row.map(value =>
        value instanceof Date ? value.toISOString() : value));
      const empty = workbook.rows("Empty");
      const failures = {};
      try { workbook.rows("Missing"); } catch (e) { failures.missing = e.message; }

      const again = workbook.rows();
      for (const [name, file] of [
        ["invalid", new Blob(["not an ODS file"])],
        ["repeat", blob(${JSON.stringify(await fixture("repeated.ods"))})],
      ]) {
        try { await cloud.sheet.read(file); failures[name] = "unexpected success"; }
        catch (e) { failures[name] = e.message; }
      }
      const bytes = new Uint8Array(await input.arrayBuffer());
      const zip = new DataView(bytes.buffer);
      for (let i = 0; i < bytes.length - 46; i++) {
        if (zip.getUint32(i, true) === 0x02014b50) {
          zip.setUint32(i + 24, 129 * 1024 * 1024, true); break;
        }
      }
      try { await cloud.sheet.read(new Blob([bytes])); failures.size = "unexpected success"; }
      catch (e) { failures.size = e.message; }
      // XLSX still uses its existing decimal-preserving parser.
      const excel = await cloud.sheet.read(blob(${JSON.stringify(await fixture("ledger.xlsx"))}), {numbers:"string"});
      const excelAmount = excel.rows("Ledger")[1][1];

      // Writing goes through the same worker and reads back with automatic format detection.
      const written = await cloud.sheet.toOds([{ name: "Export/2026", rows: [
        ["Text", "Number", "Flag", "Date", "Empty"],
        ["Müller & Söhne", 12.34, true, new Date("2026-09-20T00:00:00Z"), null],
      ]}]);
      const back = await cloud.sheet.read(written);
      const roundTrip = {
        type: written.type,
        names: back.sheetNames,
        rows: back.rows("Export_2026").map(row => row.map(value => value instanceof Date ? value.toISOString() : value)),
      };

      try { await cloud.sheet.toOds([{ name: "Bad", rows: [[{ formula: "=1" }]] }]); failures.write = "unexpected success"; }
      catch (e) { failures.write = e.message; }
      return {names, ledger, types, empty, failures, excelAmount, roundTrip};
    }
  `,
      },
    ],
  });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = "/api/assistant/artifacts/runtime/chunks/";
      if (path.startsWith(prefix)) {
        const name = ChunkName.safeParse(path.slice(prefix.length));
        return name.success
          ? new Response(await chunkSource(name.data), { headers: { "Content-Type": "text/javascript" } })
          : new Response("Unknown runtime library", { status: 404 });
      }
      return new Response("<!doctype html><body></body>", { headers: { "Content-Type": "text/html" } });
    },
  });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.addScriptTag({ content: harness });
    const result = await page.evaluate((source) => runArtifactScenario({ source }), source);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual({
      names: ["Ledger", "Types", "Empty"],
      ledger: [
        ["Reference", "Amount"],
        ["Müller & Söhne", 12.34],
        ["Müller & Söhne", 12.34],
        [],
        [],
        ["Cached formula", 24.68],
        ["No cache", null],
      ],
      types: [
        [true, false, "2026-09-20T00:00:00.000Z", 0.25, null, null, 7, 7, "PT1H30M"],
        ["Merged", null, "Line 1\nLine  2"],
      ],
      empty: [],
      failures: {
        missing: "Sheet not found: Missing",
        invalid: expect.stringContaining("XLSX ZIP"),
        repeat: expect.stringContaining("limit"),
        size: expect.stringContaining("128 MiB"),
        write: "Bad row 1 column 1: cells must be strings, numbers, booleans, dates, or null",
      },
      excelAmount: "12.34",
      roundTrip: {
        type: "application/vnd.oasis.opendocument.spreadsheet",
        names: ["Export_2026"],
        rows: [
          ["Text", "Number", "Flag", "Date", "Empty"],
          ["Müller & Söhne", 12.34, true, "2026-09-20T00:00:00.000Z"],
        ],
      },
    });
    expect(result.responsive).toBe(true);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60_000);
