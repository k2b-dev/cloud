export const NOTE_TITLE_MAX_LENGTH = 200;
export const UNTITLED_NOTE_TITLE = "Untitled";

type Fence = {
  marker: "`" | "~";
  length: number;
};

const decodeEntity = (entity: string): string => {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  const body = entity.slice(1, -1);
  if (body in named) return named[body]!;
  if (/^#\d+$/.test(body)) return String.fromCodePoint(Number(body.slice(1)));
  if (/^#x[\da-f]+$/i.test(body)) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
  return entity;
};

const toPlainText = (value: string): string => {
  let text = value.trim();
  text = text.replace(/^\s{0,3}(?:>\s*|[-+*]\s+|\d+[.)]\s+)/, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/(`+)(.*?)\1/g, "$2");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/([*_])([^*_]+)\1/g, "$2");
  text = text.replace(/\\([\\`*_[\]{}()#+.!~-])/g, "$1");
  text = text.replace(/&(?:#\d+|#x[\da-f]+|amp|apos|gt|lt|quot);/gi, decodeEntity);
  return text.replace(/\s+/g, " ").trim();
};

export const normalizeNoteTitle = (value: string, fallback = UNTITLED_NOTE_TITLE): string => {
  const normalized = toPlainText(value);
  if (!normalized) return fallback;
  return Array.from(normalized).slice(0, NOTE_TITLE_MAX_LENGTH).join("");
};

const fenceForLine = (line: string): Fence | null => {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if (!match?.[1]) return null;
  return {
    marker: match[1][0] as Fence["marker"],
    length: match[1].length,
  };
};

const closesFence = (line: string, fence: Fence): boolean => {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^\\s{0,3}${marker}{${fence.length},}\\s*$`).test(line);
};

const findNoteTitleCandidate = (markdown: string | null | undefined): { text: string; heading: boolean } | null => {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let fence: Fence | null = null;
  let fallback: string | null = null;
  let previousContentLine: string | null = null;

  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }

    const openingFence = fenceForLine(line);
    if (openingFence) {
      fence = openingFence;
      previousContentLine = null;
      continue;
    }

    const atxHeading = line.match(/^\s{0,3}#(?:[\t ]+|$)(.*)$/);
    if (atxHeading) {
      const heading = atxHeading[1]?.replace(/[\t ]+#+[\t ]*$/, "") ?? "";
      if (normalizeNoteTitle(heading, "")) return { text: heading, heading: true };
      previousContentLine = null;
      continue;
    }

    if (/^\s{0,3}=+\s*$/.test(line) && previousContentLine !== null) {
      if (normalizeNoteTitle(previousContentLine, "")) return { text: previousContentLine, heading: true };
      previousContentLine = null;
      continue;
    }

    const trimmed = line.trim();
    const isRule = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    if (trimmed && !isRule && !/^\s{0,3}-+\s*$/.test(line) && normalizeNoteTitle(line, "")) {
      fallback ??= line;
      previousContentLine = line;
    } else {
      previousContentLine = null;
    }
  }

  return fallback === null ? null : { text: fallback, heading: false };
};

export const hasUsableNoteTitle = (markdown: string | null | undefined): boolean => {
  const candidate = findNoteTitleCandidate(markdown);
  return candidate !== null && normalizeNoteTitle(candidate.text, "").length > 0;
};

/** True when the title comes from a level-1 heading rather than the first content line. */
export const hasNoteTitleHeading = (markdown: string | null | undefined): boolean => findNoteTitleCandidate(markdown)?.heading ?? false;

export const deriveNoteTitle = (markdown: string | null | undefined): string =>
  normalizeNoteTitle(findNoteTitleCandidate(markdown)?.text ?? "");

export const createInitialNoteMarkdown = (title: string, content = ""): string => {
  const heading = `# ${normalizeNoteTitle(title)}\n`;
  return content.length > 0 ? `${heading}\n${content}` : heading;
};
