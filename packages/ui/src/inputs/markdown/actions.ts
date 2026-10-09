import { replaceTextareaRange as replaceRange } from "../editor-dom";

const lineAt = (value: string, position: number): { lineStart: number; lineEnd: number; line: string } => {
  const lineStart = value.lastIndexOf("\n", position - 1) + 1;
  const nextNewline = value.indexOf("\n", position);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  return { lineStart, lineEnd, line: value.slice(lineStart, lineEnd) };
};

const selectedLineRange = (textarea: HTMLTextAreaElement): { start: number; end: number; lines: string[] } => {
  const { value, selectionStart, selectionEnd } = textarea;
  const startLine = lineAt(value, selectionStart);
  const adjustedEnd =
    selectionEnd > selectionStart && selectionEnd > 0 && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
  const endLine = lineAt(value, adjustedEnd);
  return {
    start: startLine.lineStart,
    end: endLine.lineEnd,
    lines: value.slice(startLine.lineStart, endLine.lineEnd).split("\n"),
  };
};

const toggleInlineWrap = (textarea: HTMLTextAreaElement, marker: string, placeholder: string): void => {
  const { value, selectionStart, selectionEnd } = textarea;
  const markerLength = marker.length;
  // A one-character marker never takes half of a doubled one, so italic `*` leaves bold `**` alone.
  const doubled = (text: string, from: number, step: 1 | -1) =>
    markerLength === 1 && text[from] === marker && text[from + step] === marker && text[from + 2 * step] !== marker;
  const before = value.slice(Math.max(0, selectionStart - markerLength), selectionStart);
  const after = value.slice(selectionEnd, selectionEnd + markerLength);
  if (before === marker && after === marker && !doubled(value, selectionStart - 1, -1) && !doubled(value, selectionEnd, 1)) {
    replaceRange(textarea, selectionStart - markerLength, selectionEnd + markerLength, value.slice(selectionStart, selectionEnd));
    textarea.setSelectionRange(selectionStart - markerLength, selectionEnd - markerLength);
    return;
  }

  const selected = value.slice(selectionStart, selectionEnd);
  if (
    selected.length >= markerLength * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    !doubled(selected, 0, 1) &&
    !doubled(selected, selected.length - 1, -1)
  ) {
    const stripped = selected.slice(markerLength, -markerLength);
    replaceRange(textarea, selectionStart, selectionEnd, stripped);
    textarea.setSelectionRange(selectionStart, selectionStart + stripped.length);
    return;
  }

  if (selectionStart === selectionEnd) {
    replaceRange(textarea, selectionStart, selectionEnd, marker + placeholder + marker);
    textarea.setSelectionRange(selectionStart + markerLength, selectionStart + markerLength + placeholder.length);
  } else {
    replaceRange(textarea, selectionStart, selectionEnd, marker + selected + marker);
    textarea.setSelectionRange(selectionStart + markerLength, selectionStart + markerLength + selected.length);
  }
};

export const toggleBold = (textarea: HTMLTextAreaElement): void => toggleInlineWrap(textarea, "**", "bold text");
export const toggleItalic = (textarea: HTMLTextAreaElement): void => toggleInlineWrap(textarea, "*", "italic text");
export const toggleCode = (textarea: HTMLTextAreaElement): void => toggleInlineWrap(textarea, "`", "code");
/** Wraps the selection in `marker`, or unwraps it; without a selection the caret lands between two markers. */
export const toggleInlineMarker = (textarea: HTMLTextAreaElement, marker: string): void => toggleInlineWrap(textarea, marker, "");

export const insertLink = (textarea: HTMLTextAreaElement, url?: string): void => {
  const { value, selectionStart, selectionEnd } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);
  const label = selected || "link";
  const finalUrl = url ?? "";
  replaceRange(textarea, selectionStart, selectionEnd, `[${label}](${finalUrl})`);
  if (finalUrl) {
    textarea.setSelectionRange(selectionStart + 1, selectionStart + 1 + label.length);
  } else {
    const caret = selectionStart + label.length + 3;
    textarea.setSelectionRange(caret, caret);
  }
};

const togglePrefix = (textarea: HTMLTextAreaElement, prefix: string): void => {
  const { start, end, lines } = selectedLineRange(textarea);
  const parts = lines.map((line) => {
    const match = /^(\s*)(.*)$/.exec(line)!;
    return { indent: match[1]!, body: match[2]! };
  });
  const remove = parts.every(({ body }) => body.startsWith(prefix));
  const replacement = parts.map(({ indent, body }) => (remove ? indent + body.slice(prefix.length) : indent + prefix + body)).join("\n");
  replaceRange(textarea, start, end, replacement);
  textarea.setSelectionRange(start, start + replacement.length);
};

export const toggleHeading = (textarea: HTMLTextAreaElement, level: 1 | 2 | 3): void => {
  const oldCaret = textarea.selectionStart;
  const { lineStart, lineEnd, line } = lineAt(textarea.value, oldCaret);
  const prefix = `${"#".repeat(level)} `;
  const existing = /^(#{1,6})\s/.exec(line);
  const next =
    existing?.[1]?.length === level ? line.slice(existing[0].length) : existing ? prefix + line.slice(existing[0].length) : prefix + line;
  replaceRange(textarea, lineStart, lineEnd, next);
  const desired = Math.max(lineStart, oldCaret + next.length - line.length);
  const caret = Math.min(desired, lineStart + next.length);
  textarea.setSelectionRange(caret, caret);
};

export const toggleBulletList = (textarea: HTMLTextAreaElement): void => togglePrefix(textarea, "- ");

export const toggleQuote = (textarea: HTMLTextAreaElement): void => togglePrefix(textarea, "> ");

export const toggleNumberedList = (textarea: HTMLTextAreaElement): void => {
  const { start, end, lines } = selectedLineRange(textarea);
  const parts = lines.map((line) => {
    const match = /^(\s*)(\d+\.\s)?(.*)$/.exec(line)!;
    return {
      indent: match[1] ?? "",
      marker: match[2],
      body: match[3] ?? "",
    };
  });
  const remove = parts.every(({ marker }) => Boolean(marker));
  const replacement = parts.map(({ indent, body }, index) => (remove ? indent + body : `${indent}${index + 1}. ${body}`)).join("\n");
  replaceRange(textarea, start, end, replacement);
  textarea.setSelectionRange(start, start + replacement.length);
};
