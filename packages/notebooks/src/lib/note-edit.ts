import { createHash } from "node:crypto";
import { extractNamedBlocks, type NamedBlock, type NamedBlockType, namedBlockBody } from "./named-blocks";

export type NoteEditBlockSelector = {
  name: string;
  type?: NamedBlockType;
  index?: number;
};

export type NoteEditOperation =
  | { kind: "set-content"; content: string }
  | { kind: "append"; content: string; separator?: "none" }
  | { kind: "prepend"; content: string }
  | { kind: "insert-before-line"; line: number; content: string }
  | { kind: "insert-after-line"; line: number; content: string }
  | { kind: "replace-lines"; startLine: number; endLine: number; content: string }
  | { kind: "delete-lines"; startLine: number; endLine: number }
  | ({ kind: "replace-block"; content: string; includeHandle?: boolean } & NoteEditBlockSelector)
  | ({ kind: "append-block"; content: string } & NoteEditBlockSelector)
  | ({ kind: "prepend-block"; content: string } & NoteEditBlockSelector);

export type NoteEditPreconditions = {
  ifContentHash?: string;
  ifBlockHash?: string;
};

export type NoteEditBlockSummary = {
  name: string;
  type: NamedBlockType;
  line: number;
  startLine: number;
  endLine: number;
  hash: string;
};

export type NoteEditResult = {
  content: string;
  changed: boolean;
  beforeHash: string;
  afterHash: string;
  blocks: NoteEditBlockSummary[];
};

export class NoteEditError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "not-found" | "ambiguous" | "invalid",
    readonly status: 400 | 404 | 409 = code === "conflict" ? 409 : code === "not-found" ? 404 : 400,
  ) {
    super(message);
  }
}

type LineInfo = {
  text: string;
  from: number;
  to: number;
  nextFrom: number;
};

export const noteContentHash = (content: string | null | undefined): string =>
  `sha256:${createHash("sha256")
    .update(content ?? "")
    .digest("hex")}`;

const linesWithOffsets = (content: string): LineInfo[] => {
  const lines: LineInfo[] = [];
  let from = 0;
  while (from <= content.length) {
    const nl = content.indexOf("\n", from);
    const to = nl === -1 ? content.length : nl;
    lines.push({ text: content.slice(from, to), from, to, nextFrom: nl === -1 ? to : nl + 1 });
    if (nl === -1) break;
    from = nl + 1;
  }
  return lines;
};

const assertPositiveLine = (line: number, label: string) => {
  if (!Number.isInteger(line) || line < 1) {
    throw new NoteEditError(`${label} must be a 1-based positive integer.`, "invalid");
  }
};

const lineRangeToOffsets = (content: string, startLine: number, endLine: number): { from: number; to: number } => {
  assertPositiveLine(startLine, "startLine");
  assertPositiveLine(endLine, "endLine");
  if (endLine < startLine) throw new NoteEditError("endLine must be greater than or equal to startLine.", "invalid");

  const lines = linesWithOffsets(content);
  const start = lines[startLine - 1];
  const end = lines[endLine - 1];
  if (!start || !end) {
    throw new NoteEditError(`Line range ${startLine}:${endLine} is outside the document (${lines.length} lines).`, "invalid");
  }

  return { from: start.from, to: end.nextFrom };
};

const lineBoundaryOffset = (content: string, line: number, edge: "before" | "after"): number => {
  assertPositiveLine(line, "line");
  const lines = linesWithOffsets(content);
  const item = lines[line - 1];
  if (!item) throw new NoteEditError(`Line ${line} is outside the document (${lines.length} lines).`, "invalid");
  return edge === "before" ? item.from : item.nextFrom;
};

const normalizeInsertedBlock = (
  content: string,
  from: number,
  to: number,
  replacement: string,
  options: { preserveLineBoundary: boolean },
): string => {
  if (replacement.length === 0) return "";
  const needsTrailingNewline = to < content.length && !replacement.endsWith("\n") && (options.preserveLineBoundary || content[to] !== "\n");
  const needsLeadingNewline = from > 0 && content[from - 1] !== "\n" && !replacement.startsWith("\n");
  return `${needsLeadingNewline ? "\n" : ""}${replacement}${needsTrailingNewline ? "\n" : ""}`;
};

const appendSeparator = (content: string, offset: number): string => {
  const before = content.slice(0, offset);
  if (before.length === 0 || before.endsWith("\n\n")) return "";
  if (before.endsWith("\n")) return "\n";
  return "\n\n";
};

const prependSeparator = (content: string, offset: number): string => {
  const after = content.slice(offset);
  if (after.length === 0 || after.startsWith("\n\n")) return "";
  if (after.startsWith("\n")) return "\n";
  return "\n\n";
};

const resolveBlock = (content: string, selector: NoteEditBlockSelector): NamedBlock => {
  const matches = extractNamedBlocks(content).filter(
    (block) => block.name === selector.name && (selector.type === undefined || block.type === selector.type),
  );
  const index = selector.index ?? 0;
  if (selector.index !== undefined && (!Number.isInteger(selector.index) || selector.index < 0)) {
    throw new NoteEditError("Block index must be a 0-based positive integer.", "invalid");
  }
  if (matches.length === 0) {
    const type = selector.type ? ` ${selector.type}` : "";
    throw new NoteEditError(`Named block @${selector.name}${type} was not found.`, "not-found");
  }
  if (selector.index === undefined && matches.length > 1) {
    throw new NoteEditError(`Named block @${selector.name} is ambiguous (${matches.length} matches). Pass an index.`, "ambiguous");
  }
  const block = matches[index];
  if (!block) {
    throw new NoteEditError(`Named block @${selector.name} index ${index} was not found.`, "not-found");
  }
  return block;
};

export const summarizeNoteEditBlocks = (content: string | null | undefined): NoteEditBlockSummary[] =>
  extractNamedBlocks(content ?? "").map((block) => ({
    name: block.name,
    type: block.type,
    line: block.line + 1,
    startLine: block.startLine + 1,
    endLine: block.endLine + 1,
    hash: noteContentHash(namedBlockBody(content ?? "", block)),
  }));

const applyOne = (content: string, operation: NoteEditOperation): string => {
  switch (operation.kind) {
    case "set-content":
      return operation.content;
    case "append": {
      const separator = operation.separator === "none" || content.length === 0 || content.endsWith("\n") ? "" : "\n\n";
      return `${content}${separator}${operation.content}`;
    }
    case "prepend": {
      const separator = content.length === 0 || content.startsWith("\n") ? "" : "\n\n";
      return `${operation.content}${separator}${content}`;
    }
    case "insert-before-line": {
      const offset = lineBoundaryOffset(content, operation.line, "before");
      return `${content.slice(0, offset)}${normalizeInsertedBlock(content, offset, offset, operation.content, { preserveLineBoundary: true })}${content.slice(offset)}`;
    }
    case "insert-after-line": {
      const offset = lineBoundaryOffset(content, operation.line, "after");
      return `${content.slice(0, offset)}${normalizeInsertedBlock(content, offset, offset, operation.content, { preserveLineBoundary: true })}${content.slice(offset)}`;
    }
    case "replace-lines": {
      const range = lineRangeToOffsets(content, operation.startLine, operation.endLine);
      return `${content.slice(0, range.from)}${normalizeInsertedBlock(content, range.from, range.to, operation.content, { preserveLineBoundary: true })}${content.slice(range.to)}`;
    }
    case "delete-lines": {
      const range = lineRangeToOffsets(content, operation.startLine, operation.endLine);
      return `${content.slice(0, range.from)}${content.slice(range.to)}`;
    }
    case "replace-block": {
      const block = resolveBlock(content, operation);
      const from = operation.includeHandle ? block.handleStart : block.blockStart;
      const to = block.blockEnd;
      return `${content.slice(0, from)}${normalizeInsertedBlock(content, from, to, operation.content, { preserveLineBoundary: false })}${content.slice(to)}`;
    }
    case "append-block": {
      const block = resolveBlock(content, operation);
      const offset = block.blockEnd;
      return `${content.slice(0, offset)}${appendSeparator(content, offset)}${operation.content}${content.slice(offset)}`;
    }
    case "prepend-block": {
      const block = resolveBlock(content, operation);
      const offset = block.blockStart;
      return `${content.slice(0, offset)}${operation.content}${prependSeparator(content, offset)}${content.slice(offset)}`;
    }
  }
};

export const applyNoteEdits = (
  content: string | null | undefined,
  operations: NoteEditOperation[],
  preconditions: NoteEditPreconditions = {},
): NoteEditResult => {
  if (operations.length === 0) throw new NoteEditError("At least one edit operation is required.", "invalid");
  const before = content ?? "";
  const beforeHash = noteContentHash(before);
  if (preconditions.ifContentHash && preconditions.ifContentHash !== beforeHash) {
    throw new NoteEditError(`Content hash mismatch. Expected ${preconditions.ifContentHash}, got ${beforeHash}.`, "conflict");
  }

  if (preconditions.ifBlockHash) {
    const blockOperation = operations.find(
      (operation): operation is Extract<NoteEditOperation, NoteEditBlockSelector> => "name" in operation,
    );
    if (!blockOperation) throw new NoteEditError("ifBlockHash requires a block edit operation.", "invalid");
    const block = resolveBlock(before, blockOperation);
    const blockHash = noteContentHash(namedBlockBody(before, block));
    if (blockHash !== preconditions.ifBlockHash) {
      throw new NoteEditError(`Block @${block.name} hash mismatch. Expected ${preconditions.ifBlockHash}, got ${blockHash}.`, "conflict");
    }
  }

  let next = before;
  for (const operation of operations) {
    next = applyOne(next, operation);
  }

  return {
    content: next,
    changed: next !== before,
    beforeHash,
    afterHash: noteContentHash(next),
    blocks: summarizeNoteEditBlocks(next),
  };
};
