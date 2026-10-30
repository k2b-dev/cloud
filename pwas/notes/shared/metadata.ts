export type NoteMeta = {
  title: string;
  tags: string[];
  headings: string[];
  excerpt: string;
  tasks: { done: boolean; text: string }[];
  chart: { kind: "bar" | "line"; values: number[] } | null;
  image: string | null;
  length: number;
};

export function plainText(text: string): string {
  return text
    .replace(/!\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/\[([^[\]]+)\]\([^()]*\)/g, "$1")
    .replace(/<[^<>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, "")
    .replace(/(?<!\s)\s+#+\s*$/, "")
    .trim();
}

/** Notebooks blocks such as `:::chart` or `:::note`; data blocks hold settings, notices hold prose. */
const DATA_DIRECTIVES = new Set(["chart", "data", "query", "toc"]);

function scan(markdown: string): { lines: string[]; lineChart: boolean; chartRows: number[] } {
  let fence: { char: string; length: number; chart: boolean } | undefined;
  let directive: string | undefined;
  let lineChart = false;
  const chartRows: number[] = [];
  let firstChartDone = false;
  const lines = markdown.split(/\r?\n/).map((line) => {
    if (!fence) {
      const open = /^\s{0,3}:::\s*([a-z]+)\b/i.exec(line);
      if (!directive && open) {
        directive = open[1]?.toLowerCase();
        return "";
      }
      if (directive && /^\s{0,3}:::\s*$/.test(line)) {
        if (directive === "chart") firstChartDone = true;
        directive = undefined;
        return "";
      }
      if (directive === "chart") {
        if (!firstChartDone && /^\s*type\s*:\s*(?:line|area)\s*$/i.test(line)) lineChart = true;
        const row = /^\s*-\s*\[(.*)\]\s*$/.exec(line);
        const last = row?.[1]?.split(",").at(-1)?.trim();
        if (!firstChartDone && last !== undefined) {
          const value = numberCell(last);
          if (value !== null) chartRows.push(value);
        }
      }
      if (directive && DATA_DIRECTIVES.has(directive)) return "";
    }
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      const run = marker[1] ?? "";
      if (!fence) fence = { char: run[0] ?? "`", length: run.length, chart: marker[2]?.trim() === "chart" };
      else if (run[0] === fence.char && run.length >= fence.length && !marker[2]?.trim()) fence = undefined;
      return "";
    }
    if (fence?.chart && /^\s*type\s*:\s*(?:line|area)\s*$/.test(line)) lineChart = true;
    if (fence || /^(?: {4}|\t)/.test(line)) return "";
    return line;
  });
  return { lines, lineChart, chartRows };
}

/** Searchable prose, headings and tasks, in document order; code is excluded. */
export function deriveLines(markdown: string): string[] {
  return scan(markdown).lines.map(plainText).filter(Boolean);
}

function numberCell(value: string): number | null {
  const cell = plainText(value).replace(/\s/g, "");
  if (!/^[+-]?(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)$/.test(cell)) return null;
  const grouped = /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(cell);
  const result = Number(cell.includes(",") || grouped ? cell.replace(/\./g, "").replace(",", ".") : cell);
  return Number.isFinite(result) ? result : null;
}

function tableValues(lines: string[]): number[] | null {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  for (let i = 1; i < lines.length; i++) {
    const separator = lines[i] ?? "";
    if (!separator.includes("|") || !cells(separator).every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const header = lines[i - 1] ?? "";
    if (!header.includes("|")) continue;
    const rows: string[][] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j]?.includes("|"); j++) rows.push(cells(lines[j] ?? ""));
    for (let col = 0; col < cells(header).length; col++) {
      const values = rows.map((row) => numberCell(row[col] ?? ""));
      if (values.length && values.every((value): value is number => value !== null)) return values;
    }
    i = j;
  }
  return null;
}

export function deriveMeta(markdown: string): NoteMeta {
  const { lines, lineChart, chartRows } = scan(markdown);
  const titleIndex = lines.findIndex((line) => line.trim());
  const title = plainText(lines[titleIndex] ?? "");
  const tags = new Set<string>();
  const headings: string[] = [];
  const tasks: NoteMeta["tasks"] = [];
  const prose: string[] = [];
  let image: string | null = null;
  for (const [index, line] of lines.entries()) {
    const outsideCode = line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, "").replace(/\]\([^()]*\)/g, "]");
    for (const match of outsideCode.matchAll(/(?:^|[\s([{])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu))
      if (match[1]) tags.add(match[1].toLowerCase());
    image ??= /!\[[^[\]]*\]\(file:([A-Za-z0-9]+)\)/.exec(line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, ""))?.[1] ?? null;
    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      if (index !== titleIndex) headings.push(plainText(line));
      continue;
    }
    const task = /^\s*[-+*]\s+\[ \]\s+(.+)/.exec(line);
    if (task && tasks.length < 3) tasks.push({ done: false, text: plainText(task[1] ?? "") });
    if (
      index === titleIndex ||
      !line.trim() ||
      task ||
      /^\s*[-+*]\s+\[[xX]\]/.test(line) ||
      line.includes("|") ||
      /^\s*(?:[-*_]\s*){3,}$/.test(line)
    )
      continue;
    if (/^\s*(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(line)) continue;
    const clean = plainText(line)
      .replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean) prose.push(clean);
  }
  const values = chartRows.length > 0 ? chartRows : tableValues(lines);
  return {
    title,
    tags: [...tags],
    headings,
    excerpt: prose.join(" ").slice(0, 240),
    tasks,
    chart: values ? { kind: lineChart ? "line" : "bar", values } : null,
    image,
    length: markdown.length,
  };
}
