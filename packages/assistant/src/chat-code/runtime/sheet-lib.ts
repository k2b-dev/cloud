// cloud.sheet, loaded on first use into the app frame (blob module via the bridge).
import Papa from "papaparse";
import { CloudError } from "./errors";

async function text(input: Blob | string, encoding?: string): Promise<string> {
  if (typeof input === "string") return input;
  const bytes = new Uint8Array(await input.arrayBuffer());
  if (encoding) return new TextDecoder(encoding).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Excel on Windows still writes CSV in windows-1252.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const STRIP = /^[\s ]*(?:€|EUR|\$|USD|£|CHF)?[\s ]*|[\s ]*(?:€|EUR|\$|USD|£|CHF|%)?[\s ]*$/g;
const DE = /^[-+]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;
const EN = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
const toNumber = (value: string, style: "de" | "en") =>
  Number(style === "de" ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, ""));

/** Comma-separated exports always use dot decimals; other delimiters use the viewer locale. */
function decimalMark(delimiter: string, locale: string) {
  return delimiter === "," ? "." : new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")!.value;
}
function numberColumn(values: string[]) {
  const cells = values.map((value) => value.replace(STRIP, ""));
  const present = cells.filter((value) => value !== "");
  if (!present.length || present.some((value) => /^[-+]?0\d/.test(value))) return null;
  const de = present.every((value) => DE.test(value));
  const en = present.every((value) => EN.test(value));
  return de || en ? { cells, de, en } : null;
}

export async function parseCsv(
  input: Blob | string,
  options: { delimiter?: string; encoding?: string; numbers?: boolean },
  locale: string,
) {
  const source = (await text(input, options.encoding)).replace(/^﻿/, "");
  const data: string[][] = [];
  const lines: number[] = [];
  let delimiter = options.delimiter ?? Papa.parse<string[]>(source, { skipEmptyLines: "greedy", preview: 1 }).meta.delimiter,
    cursor = 0,
    line = 1;
  Papa.parse<string[]>(source, {
    delimiter,
    step(parsed) {
      const segment = source.slice(cursor, parsed.meta.cursor);
      const rowLine = line;
      const error = parsed.errors.find((error) => error.code !== "UndetectableDelimiter");
      if (error) throw new CloudError("invalid", `Invalid CSV at line ${rowLine}: ${error.message}`);
      if (parsed.data.some((cell) => cell.trim() !== "")) {
        data.push(parsed.data);
        lines.push(rowLine);
      }
      delimiter = parsed.meta.delimiter;
      line += segment.match(/\r\n|\r|\n/g)?.length ?? 0;
      cursor = parsed.meta.cursor;
    },
  });
  const [header = [], ...rows] = data;
  const used = new Set<string>();
  const names = header.map((name, index) => {
    const base = name.trim() || `column${index + 1}`;
    let unique = base,
      suffix = 2;
    while (used.has(unique)) unique = `${base}_${suffix++}`;
    used.add(unique);
    return unique;
  });
  rows.forEach((row, index) => {
    if (row.length > header.length)
      throw new CloudError("invalid", `Invalid CSV at line ${lines[index + 1]}: more fields than the header.`);
  });
  const columns = names.map((_, index) => rows.map((row) => (row[index] ?? "").trim()));
  const candidates = columns.map(numberColumn);
  const evidence = new Set<"de" | "en">(
    candidates.flatMap((column) => (column && column.de !== column.en ? [column.de ? "de" : "en"] : [])),
  );
  const convention = decimalMark(delimiter, locale) === "," ? "de" : "en";
  const fileStyle = evidence.size === 1 ? [...evidence][0]! : convention;
  const typed = columns.map((values, index) => {
    const column = candidates[index];
    if (options.numbers === false || !column) return values;
    const style = column.de && column.en ? fileStyle : column.de ? "de" : "en";
    const numbers = column.cells.map((value) => (value === "" ? "" : toNumber(value, style)));
    // Number() must never silently round integer identifiers or large counts.
    if (
      numbers.some(
        (value) => typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))),
      )
    )
      return values;
    return numbers;
  });
  return rows.map((_, rowIndex) => Object.fromEntries(names.map((name, index) => [name, typed[index]![rowIndex]!])));
}

export async function toCsv(rows: Record<string, unknown>[], options: { delimiter?: string; bom?: boolean }, locale: string) {
  const delimiter = options.delimiter ?? ";";
  const decimal = decimalMark(delimiter, locale);
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => {
    let out =
      value === null || value === undefined
        ? ""
        : typeof value === "number"
          ? String(value).replace(".", decimal)
          : value instanceof Date
            ? value.toISOString()
            : String(value);
    if (/^[=+\-@\t\r]/.test(out) && typeof value !== "number") out = `'${out}`;
    return /["\r\n]/.test(out) || out.includes(delimiter) ? `"${out.replace(/"/g, '""')}"` : out;
  };
  const lines = [names.map(cell).join(delimiter), ...rows.map((row) => names.map((name) => cell(row[name])).join(delimiter))];
  return `${options.bom === false ? "" : "﻿"}${lines.join("\r\n")}\r\n`;
}
