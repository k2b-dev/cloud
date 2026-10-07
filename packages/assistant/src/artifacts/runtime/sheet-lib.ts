// cloud.sheet, loaded on first use into the app frame (blob module via the bridge).
import Papa from "papaparse";

type Cell = string | number;

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

/** Converts a column to numbers when every non-empty cell is a number in one convention; keeps codes like "01234". */
function numberColumn(values: string[], delimiter: string, locale: string): Cell[] | null {
  const cells = values.map((value) => value.replace(STRIP, ""));
  const present = cells.filter((value) => value !== "");
  if (!present.length || present.some((value) => /^[-+]?0\d/.test(value))) return null;
  const de = present.every((value) => DE.test(value));
  const en = present.every((value) => EN.test(value));
  if (!de && !en) return null;
  const style = de && en ? (delimiter === ";" || /^(de|fr|es|it|nl|pt|pl|da|sv|nb|fi|cs)/.test(locale) ? "de" : "en") : de ? "de" : "en";
  return cells.map((value) => (value === "" ? "" : toNumber(value, style)));
}

export async function parseCsv(
  input: Blob | string,
  options: { delimiter?: string; encoding?: string; numbers?: boolean },
  locale: string,
) {
  const source = (await text(input, options.encoding)).replace(/^﻿/, "");
  const parsed = Papa.parse<string[]>(source, { delimiter: options.delimiter ?? "", skipEmptyLines: "greedy" });
  const [header = [], ...rows] = parsed.data;
  const names = header.map((name, index) => name.trim() || `column${index + 1}`);
  const columns = names.map((_, index) => rows.map((row) => (row[index] ?? "").trim()));
  const typed = columns.map((values) => (options.numbers === false ? null : numberColumn(values, parsed.meta.delimiter, locale)) ?? values);
  return rows.map((_, rowIndex) => Object.fromEntries(names.map((name, index) => [name, typed[index]![rowIndex]!])));
}

export async function toCsv(rows: Record<string, unknown>[], options: { delimiter?: string; bom?: boolean }, locale: string) {
  const delimiter = options.delimiter ?? ";";
  const decimal = new Intl.NumberFormat(locale).format(1.5).charAt(1);
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => {
    let out =
      value === null || value === undefined
        ? ""
        : typeof value === "number"
          ? String(value).replace(".", delimiter === ";" ? decimal : ".")
          : value instanceof Date
            ? value.toISOString()
            : String(value);
    if (/^[=+\-@\t\r]/.test(out) && typeof value !== "number") out = `'${out}`;
    return /["\r\n]/.test(out) || out.includes(delimiter) ? `"${out.replace(/"/g, '""')}"` : out;
  };
  const lines = [names.map(cell).join(delimiter), ...rows.map((row) => names.map((name) => cell(row[name])).join(delimiter))];
  return `${options.bom === false ? "" : "﻿"}${lines.join("\r\n")}\r\n`;
}
