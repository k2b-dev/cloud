import { literalMarkdownLines } from "./markdown-context";

export type Directive = {
  type: "query" | "toc" | "chart" | "map";
  body: string[];
  line: number;
  closed: boolean;
  from: number;
  to: number;
};

export const directives = (md: string): Directive[] => {
  if (!/:::(?:query|toc|chart|map)\b/.test(md)) return [];
  const lines = md.split("\n");
  const literalLines = literalMarkdownLines(md);
  const offsets: number[] = [];
  let offset = 0;
  for (const text of lines) {
    offsets.push(offset);
    offset += text.length + 1;
  }
  const found: Directive[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (literalLines.has(i)) continue;
    const text = lines[i]!;
    const opener = text.match(/^ {0,3}:::(query|toc|chart|map)[ \t]*\r?$/);
    if (!opener?.[1]) continue;
    const line = i + 1;
    const body: string[] = [];
    let closed = false;
    for (i = i + 1; i < lines.length; i++) {
      if (/^ {0,3}:::[ \t]*\r?$/.test(lines[i]!)) {
        closed = true;
        break;
      }
      // Keep raw offsets above; normalize only the body consumed by the DSL.
      body.push(lines[i]!.replace(/\r$/, ""));
    }
    found.push({
      type: opener[1] as Directive["type"],
      body,
      line,
      closed,
      from: offsets[line - 1]!,
      to: closed ? offsets[i]! + lines[i]!.length : md.length,
    });
  }
  return found;
};

/** Source geometry only; query validation and result rendering stay server-owned. */
export const extractNotebookDirectiveRanges = (md: string): Array<Pick<Directive, "type" | "line" | "from" | "to" | "closed">> =>
  directives(md).map(({ type, line, from, to, closed }) => ({ type, line, from, to, closed }));

export const DIRECTIVE_MAX_STRING_LENGTH = 2_000;
export type DirectiveScalar = string | number | boolean;
export type DirectiveValue = DirectiveScalar | DirectiveScalar[];

export type NotebookBlockDiagnosticCode =
  | "duplicate-key"
  | "invalid-field"
  | "invalid-type"
  | "missing-key"
  | "missing-value"
  | "too-many-items"
  | "unexpected-line"
  | "unknown-key"
  | "unclosed-block"
  | "unknown-block"
  | "invalid-source"
  | "duplicate-block"
  | "unknown-column"
  | "not-a-number"
  | "chart-x-type"
  | "chart-one-series"
  | "chart-unsupported";

export type NotebookBlockDiagnostic = {
  code: NotebookBlockDiagnosticCode;
  line: number;
  path: string;
  params?: { name?: string; row?: number; limit?: number };
};

export const parseScalar = (raw: string): DirectiveScalar | null => {
  const value = raw.trim();
  if (!value) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" && parsed.length <= DIRECTIVE_MAX_STRING_LENGTH ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return null;
    const parsed = value.slice(1, -1).replace(/''/g, "'");
    return parsed.length <= DIRECTIVE_MAX_STRING_LENGTH ? parsed : null;
  }
  if (/^[\[\]{}&*!|>@`]/.test(value)) return null;
  return value.length <= DIRECTIVE_MAX_STRING_LENGTH ? value : null;
};

export const splitInlineList = (raw: string): string[] | null => {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!;
    if (quote === '"' && char === "\\") {
      i++;
    } else if (quote && char === quote) {
      if (quote === "'" && inner[i + 1] === "'") i++;
      else quote = null;
    } else if (!quote && (char === "'" || char === '"') && !inner.slice(start, i).trim()) {
      quote = char;
    } else if (char === "," && !quote) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (quote) return null;
  items.push(inner.slice(start));
  return items;
};

export const parseValue = (raw: string): DirectiveValue | null => {
  const list = splitInlineList(raw);
  if (list) {
    const values = list.map(parseScalar);
    return values.every((value): value is DirectiveScalar => value !== null) ? values : null;
  }
  return parseScalar(raw);
};
