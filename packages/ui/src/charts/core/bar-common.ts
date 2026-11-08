import type { BarChartOptions } from "../../content/chart-bar";
import { escapeXml } from "./svg-common";

export const fmt = (value: number) => (Number.isFinite(value) ? `${Math.round(value * 100) / 100}` : "0");
export const tickFormat = (opts: BarChartOptions) => opts.yAxis?.format ?? ((value: number) => String(value));

/** Estimated width of `text` at `size` pixels in the UI sans font with tabular figures; a little wide on purpose. */
export const chartTextWidth = (text: string, size = 11): number => {
  let em = 0;
  for (const char of text) {
    if (/[\s.,:;!|'’ilIjft()[\]-]/.test(char)) em += 0.34;
    else if (/[MWmw@%]/.test(char)) em += 0.86;
    else if (/[A-Z0-9#$€&]/.test(char)) em += 0.66;
    else if (char.codePointAt(0)! > 0x2e80) em += 1;
    else em += 0.56;
  }
  return em * size;
};

/** Split a label into at most `lines` lines of `maxPx`; the last line ends with an ellipsis when the label is longer. */
export const wrapLabel = (label: string, maxPx: number, lines: number): { lines: string[]; truncated: boolean } => {
  const words = label.trim().split(/\s+/);
  const result: string[] = [];
  let current = "";
  const breakWord = (word: string) => {
    // A word wider than a line breaks inside the word.
    let part = "";
    for (const char of word) {
      if (part && chartTextWidth(part + char) > maxPx) {
        result.push(part);
        part = "";
      }
      part += char;
    }
    return part;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (chartTextWidth(candidate) <= maxPx) current = candidate;
    else {
      if (current) result.push(current);
      current = chartTextWidth(word) > maxPx ? breakWord(word) : word;
    }
  }
  if (current) result.push(current);
  if (result.length <= lines) return { lines: result, truncated: false };
  let last = result[lines - 1]!;
  while (last && chartTextWidth(`${last}…`) > maxPx) last = last.slice(0, -1).trimEnd();
  return { lines: [...result.slice(0, lines - 1), `${last}…`], truncated: true };
};

export const headerHeight = (opts: Pick<BarChartOptions, "title" | "subtitle">) =>
  opts.title || opts.subtitle ? (opts.title ? 14 : 0) + (opts.subtitle ? 6 : 0) + 16 : 0;

export const renderHeader = (opts: Pick<BarChartOptions, "title" | "subtitle">, width: number) => {
  const parts: string[] = [];
  let y = 16;
  if (opts.title) {
    parts.push(`<text class="stdlib-chart-title" x="${fmt(width / 2)}" y="${y}" text-anchor="middle">${escapeXml(opts.title)}</text>`);
    y += 14;
  }
  if (opts.subtitle)
    parts.push(
      `<text class="stdlib-chart-subtitle" x="${fmt(width / 2)}" y="${y}" text-anchor="middle">${escapeXml(opts.subtitle)}</text>`,
    );
  return parts.join("");
};
