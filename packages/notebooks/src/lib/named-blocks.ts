export type NamedBlockType = "table" | "list" | "data" | "section" | "unknown";

export type NamedBlock = {
  name: string;
  type: NamedBlockType;
  line: number;
  handleStart: number;
  handleEnd: number;
  blockStart: number;
  blockEnd: number;
  startLine: number;
  endLine: number;
};

export type NamedBlockSummary = Pick<NamedBlock, "name" | "type" | "line">;

export type DataBlock = Omit<NamedBlock, "name"> & {
  name: string | null;
};

export type NamedDataEntry = {
  key: string;
  value: NamedDataValue;
};

export type NamedDataScalar = string | number | boolean;
export type NamedDataValue = NamedDataScalar | NamedDataScalar[];
export type NamedDataDiagnostic = {
  code: "duplicate-block" | "duplicate-key" | "invalid-value" | "too-many-items" | "unclosed-block" | "unexpected-line";
  line: number;
  path: string;
};

export type NamedDataProperties = Record<string, Record<string, NamedDataValue>>;

export const DATA_MAX_ENTRIES = 64;
export const DATA_MAX_LIST_ITEMS = 128;
export const DATA_MAX_STRING_LENGTH = 2_000;

type Line = {
  text: string;
  from: number;
  to: number;
  nextFrom: number;
};

const HANDLE_RE = /^@([A-Za-z][A-Za-z0-9_-]{0,63})\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_RE = /^(#{1,6})\s+/;

export const isNamedBlockHandle = (line: string): string | null => line.trim().match(HANDLE_RE)?.[1] ?? null;

const linesWithOffsets = (md: string): Line[] => {
  const lines: Line[] = [];
  let from = 0;
  while (from <= md.length) {
    const nl = md.indexOf("\n", from);
    const to = nl === -1 ? md.length : nl;
    lines.push({ text: md.slice(from, to), from, to, nextFrom: nl === -1 ? to : nl + 1 });
    if (nl === -1) break;
    from = nl + 1;
  }
  return lines;
};

const nextContentLine = (lines: Line[], start: number): number | null => {
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.text.trim().length > 0) return i;
  }
  return null;
};

const isTableStart = (lines: Line[], index: number): boolean =>
  !!lines[index]?.text.includes("|") && !!lines[index + 1] && TABLE_SEPARATOR_RE.test(lines[index + 1]!.text);

const tableEndLine = (lines: Line[], start: number): number => {
  let end = start + 1;
  for (let i = start + 2; i < lines.length; i++) {
    if (!lines[i]!.text.includes("|") || lines[i]!.text.trim().length === 0) break;
    end = i;
  }
  return end;
};

const listEndLine = (lines: Line[], start: number): number => {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.text;
    if (line.trim().length === 0) {
      break;
    }
    if (!LIST_RE.test(line) && !/^\s{2,}\S/.test(line)) break;
    end = i;
  }
  return end;
};

const fencedEndLine = (lines: Line[], start: number, marker: string): number => {
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.text.trim() === marker) return i;
  }
  return start;
};

const sectionEndLine = (lines: Line[], start: number): number => {
  const match = lines[start]!.text.match(HEADING_RE);
  const level = match?.[1]?.length ?? 6;
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i++) {
    const next = lines[i]!.text.match(HEADING_RE);
    if (next && next[1]!.length <= level) {
      end = Math.max(start, i - 1);
      break;
    }
  }
  return end;
};

export const extractNamedBlocks = (md: string | null | undefined): NamedBlock[] => {
  if (!md) return [];
  const lines = linesWithOffsets(md);
  const blocks: NamedBlock[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.text.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0]!;
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const name = isNamedBlockHandle(line.text);
    if (!name) continue;

    const startLine = nextContentLine(lines, i + 1);
    if (startLine === null) {
      blocks.push({
        name,
        type: "unknown",
        line: i,
        handleStart: line.from,
        handleEnd: line.to,
        blockStart: line.to,
        blockEnd: line.to,
        startLine: i,
        endLine: i,
      });
      continue;
    }

    let type: NamedBlockType = "unknown";
    let endLine = startLine;
    const startText = lines[startLine]!.text.trim();
    if (isTableStart(lines, startLine)) {
      type = "table";
      endLine = tableEndLine(lines, startLine);
    } else if (LIST_RE.test(lines[startLine]!.text)) {
      type = "list";
      endLine = listEndLine(lines, startLine);
    } else if (/^:::data\b/.test(startText)) {
      type = "data";
      endLine = fencedEndLine(lines, startLine, ":::");
    } else if (HEADING_RE.test(lines[startLine]!.text)) {
      type = "section";
      endLine = sectionEndLine(lines, startLine);
    }

    blocks.push({
      name,
      type,
      line: i,
      handleStart: line.from,
      handleEnd: line.to,
      blockStart: lines[startLine]!.from,
      blockEnd: lines[endLine]!.to,
      startLine,
      endLine,
    });
    // Sections may contain additional named blocks. Keep scanning their
    // body so a dashboard section can expose smaller referenceable parts.
    if (type !== "section") i = endLine;
  }

  return blocks;
};

export const extractNamedBlockSummaries = (md: string | null | undefined): NamedBlockSummary[] =>
  extractNamedBlocks(md).map(({ name, type, line }) => ({ name, type, line }));

export const extractDataBlocks = (md: string | null | undefined): DataBlock[] => {
  if (!md) return [];
  const lines = linesWithOffsets(md);
  const namedDataBlocks = extractNamedBlocks(md).filter((block) => block.type === "data");
  const namedDataStarts = new Set(namedDataBlocks.map((block) => block.blockStart));
  const blocks: DataBlock[] = namedDataBlocks.map((block) => ({ ...block }));
  let fence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.text.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0]!;
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || !/^:::data\b/.test(trimmed) || namedDataStarts.has(line.from)) continue;

    const endLine = fencedEndLine(lines, i, ":::");
    blocks.push({
      name: null,
      type: "data",
      line: i,
      handleStart: line.from,
      handleEnd: line.from,
      blockStart: line.from,
      blockEnd: lines[endLine]!.to,
      startLine: i,
      endLine,
    });
    i = endLine;
  }

  return blocks.sort((a, b) => a.handleStart - b.handleStart);
};

export const findNamedBlocks = (md: string, name: string, type?: NamedBlockType): NamedBlock[] =>
  extractNamedBlocks(md).filter((block) => block.name === name && (!type || block.type === type));

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const namedBlockBody = (md: string, block: Pick<NamedBlock, "startLine" | "endLine" | "blockStart" | "blockEnd">): string => {
  const lines = linesWithOffsets(md);
  const firstContent = lines[block.startLine]?.nextFrom ?? block.blockStart;
  const closingLineStart = block.endLine > block.startLine ? (lines[block.endLine]?.from ?? block.blockEnd) : block.blockEnd;
  return md.slice(firstContent, closingLineStart).trim();
};

const parseDataScalar = (raw: string): NamedDataScalar | null => {
  const value = raw.trim();
  if (!value) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" && parsed.length <= DATA_MAX_STRING_LENGTH ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    const parsed = value.slice(1, -1).replace(/''/g, "'");
    return parsed.length <= DATA_MAX_STRING_LENGTH ? parsed : null;
  }
  if (/^[\[\]{}&*!|>@`]/.test(value)) return null;
  return value.length <= DATA_MAX_STRING_LENGTH ? value : null;
};

export const parseNamedDataBlockResult = (src: string): { entries: NamedDataEntry[]; diagnostics: NamedDataDiagnostic[] } => {
  const entries: NamedDataEntry[] = [];
  const diagnostics: NamedDataDiagnostic[] = [];
  const keys = new Set<string>();
  let activeArray: NamedDataEntry | null = null;
  for (const [index, line] of src.split("\n").entries()) {
    const lineNumber = index + 1;
    if (!line.trim()) continue;
    const item = line.match(/^\s{2}-\s+(.+)$/);
    if (activeArray && item?.[1]) {
      if ((activeArray.value as NamedDataScalar[]).length >= DATA_MAX_LIST_ITEMS) {
        diagnostics.push({ code: "too-many-items", line: lineNumber, path: activeArray.key });
        continue;
      }
      const value = parseDataScalar(item[1]);
      if (value === null) diagnostics.push({ code: "invalid-value", line: lineNumber, path: activeArray.key });
      else (activeArray.value as NamedDataScalar[]).push(value);
      continue;
    }

    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!pair?.[1]) {
      diagnostics.push({ code: "unexpected-line", line: lineNumber, path: "data" });
      activeArray = null;
      continue;
    }
    const key = pair[1];
    if (keys.has(key)) {
      diagnostics.push({ code: "duplicate-key", line: lineNumber, path: key });
      activeArray = null;
      continue;
    }
    keys.add(key);
    if (entries.length >= DATA_MAX_ENTRIES) {
      diagnostics.push({ code: "too-many-items", line: lineNumber, path: "data" });
      activeArray = null;
      continue;
    }
    const rawValue = pair[2]?.trim() ?? "";
    const value = rawValue ? parseDataScalar(rawValue) : [];
    if (value === null) {
      diagnostics.push({ code: "invalid-value", line: lineNumber, path: key });
      activeArray = null;
      continue;
    }
    const entry: NamedDataEntry = { key, value };
    entries.push(entry);
    activeArray = Array.isArray(entry.value) ? entry : null;
  }
  return { entries, diagnostics };
};

export const parseNamedDataBlock = (src: string): NamedDataEntry[] => parseNamedDataBlockResult(src).entries;

export const extractNamedDataProperties = (
  md: string | null | undefined,
): { properties: NamedDataProperties; diagnostics: NamedDataDiagnostic[] } => {
  if (!md) return { properties: {}, diagnostics: [] };
  const blocks = extractNamedBlocks(md).filter((block) => block.type === "data");
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.name, (counts.get(block.name) ?? 0) + 1);

  const properties: NamedDataProperties = {};
  const diagnostics: NamedDataDiagnostic[] = [];
  const reportedDuplicates = new Set<string>();
  for (const block of blocks) {
    if ((counts.get(block.name) ?? 0) > 1) {
      if (!reportedDuplicates.has(block.name)) {
        diagnostics.push({ code: "duplicate-block", line: block.line + 1, path: block.name });
        reportedDuplicates.add(block.name);
      }
      continue;
    }
    if (block.endLine === block.startLine) {
      diagnostics.push({ code: "unclosed-block", line: block.startLine + 1, path: block.name });
      continue;
    }
    const parsed = parseNamedDataBlockResult(namedBlockBody(md, block));
    diagnostics.push(
      ...parsed.diagnostics.map((entry) => ({ ...entry, line: block.startLine + entry.line + 1, path: `${block.name}.${entry.path}` })),
    );
    if (parsed.diagnostics.length > 0) continue;
    properties[block.name] = Object.fromEntries(parsed.entries.map(({ key, value }) => [key, value]));
  }
  return { properties, diagnostics };
};

const humanizeKey = (key: string): string =>
  key
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());

export const renderDataBlockHtml = (name: string | null, src: string): string => {
  const entries = parseNamedDataBlock(src);
  const handle = name
    ? `<div class="md-block-handle" data-block-name="${escapeHtml(name)}">@${escapeHtml(name)}</div>`
    : `<div class="md-data-handle-row"><div class="md-block-handle">data</div><span class="md-data-reference-hint">add @ref to use in scripts</span></div>`;
  const rows =
    entries.length > 0
      ? entries
          .map((entry) => {
            const value = Array.isArray(entry.value)
              ? entry.value.map((item) => `<span class="md-data-chip">${escapeHtml(String(item))}</span>`).join("")
              : escapeHtml(String(entry.value));
            return `<div class="md-data-row"><span class="md-data-key">${escapeHtml(humanizeKey(entry.key))}</span><span class="md-data-value">${value}</span></div>`;
          })
          .join("")
      : `<div class="md-data-empty">No data</div>`;

  return (
    `<div class="md-data-block"${name ? ` data-block-name="${escapeHtml(name)}"` : ""}>` +
    handle +
    `<div class="md-data-grid">${rows}</div>` +
    `</div>`
  );
};

export const renderNamedDataBlockHtml = (name: string, src: string): string => renderDataBlockHtml(name, src);

export const renderNamedBlockHandlesMarkdown = (md: string | null | undefined): string => {
  if (!md) return "";
  let out = md;

  const replacements: { from: number; to: number; html: string }[] = [];
  for (const block of extractDataBlocks(md)) {
    replacements.push({
      from: block.name ? block.handleStart : block.blockStart,
      to: block.blockEnd,
      html: renderDataBlockHtml(block.name, namedBlockBody(md, block)),
    });
  }
  for (const block of extractNamedBlocks(md)) {
    if (block.type === "data") continue;
    const handle = `<div class="md-block-handle" data-block-name="${escapeHtml(block.name)}">@${escapeHtml(block.name)}</div>`;
    replacements.push({ from: block.handleStart, to: block.handleEnd, html: handle });
  }

  for (const replacement of replacements.sort((a, b) => b.from - a.from)) {
    out = `${out.slice(0, replacement.from)}${replacement.html}${out.slice(replacement.to)}`;
  }
  return out;
};
