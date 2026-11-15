/**
 * Display highlighters for CodeDisplay, CodeDiff and DocCode.
 *
 * TypeScript and JavaScript come from the linear `@k2b/stdlib` code preset
 * (`hl-*` classes); Markdown and SQL keep their small line-based scanners here
 * (`cd-*` classes). Every input character is HTML-escaped before it is wrapped
 * in a token span, so the returned strings are safe to inject with `innerHTML`.
 */
import { highlight } from "@k2b/stdlib";

export type CodeDisplayLanguage = "ts" | "tsx" | "js" | "jsx" | "script" | "markdown" | "md" | "text" | "sql";

const escapeCodeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isDigit = (c: string): boolean => /[0-9]/.test(c);
const wrap = (cls: string, raw: string): string => `<span class="${cls}">${escapeCodeHtml(raw)}</span>`;
const isCodeLanguage = (language: string | undefined): boolean =>
  language === "script" || language === "js" || language === "jsx" || language === "ts" || language === "tsx";

const TOKEN = /(<span class="[^"]*">|<\/span>)/;
const EMPTY_TOKEN = /<span class="[^"]*"><\/span>/g;

/**
 * One display line per source line. A token that spans lines, such as a block comment or a template string, closes at
 * each line end and opens again on the next line, so every line is balanced HTML. The stdlib output is flat: spans
 * never nest.
 */
const highlightedLines = (html: string): string[] => {
  const lines: string[] = [];
  let line = "";
  let open = "";
  for (const part of html.split(TOKEN)) {
    if (part.startsWith("<span ")) open = part;
    else if (part === "</span>") open = "";
    const [first = "", ...rest] = open === part || part === "</span>" ? [part] : part.split("\n");
    line += first;
    for (const piece of rest) {
      lines.push((open ? `${line}</span>` : line).replace(EMPTY_TOKEN, ""));
      line = open + piece;
    }
  }
  lines.push(line.replace(EMPTY_TOKEN, ""));
  return lines;
};

/** TypeScript and JavaScript, the whole text at once so tokens across lines keep their meaning. */
const highlightCodeLines = (code: string): string[] => highlightedLines(highlight.presets.code(code));

const highlightMarkdownLine = (line: string): string => {
  const escaped = escapeCodeHtml(line);

  const heading = /^(#{1,6})(\s.*)$/.exec(escaped);
  if (heading) return `<span class="cd-md-syntax">${heading[1]}</span>${highlightMarkdownInline(heading[2] ?? "")}`;

  const ref = /^(@[A-Za-z][\w-]*)$/.exec(escaped);
  if (ref) return `<span class="cd-md-ref">${ref[1]}</span>`;

  // Consume each prefix once before checking its remainder. Keeping them in
  // separate matches prevents retrying shorter prefixes when the tail fails.
  const directive = /^\s*:::/.exec(escaped);
  if (directive) {
    const rest = escaped.slice(directive[0].length);
    const name = /^[A-Za-z][\w-]*/.exec(rest)?.[0] ?? "";
    const tail = /^(.*)$/.exec(rest.slice(name.length));
    if (tail) {
      const highlightedName = name ? `<span class="cd-md-directive">${name}</span>` : "";
      return `<span class="cd-md-syntax">${directive[0]}</span>${highlightedName}${highlightMarkdownInline(tail[1] ?? "")}`;
    }
  }

  const fence = /^(```)(.*)$/.exec(escaped);
  if (fence) {
    const language = fence[2] ? `<span class="cd-md-ref">${fence[2]}</span>` : "";
    return `<span class="cd-md-syntax">${fence[1]}</span>${language}`;
  }

  const table = /^(\s*\|)(.*)(\|\s*)$/.exec(escaped);
  if (table) return `<span class="cd-md-syntax">${table[1]}</span>${table[2]}<span class="cd-md-syntax">${table[3]}</span>`;

  const list = /^\s*(?:[-*+]|\d+\.)\s+/.exec(escaped);
  if (list) {
    const rest = escaped.slice(list[0].length);
    const task = /^(\[[ xX]\])(\s+)/.exec(rest);
    const taskTail = task && /^(.*)$/.exec(rest.slice(task[0].length));
    if (task && taskTail) {
      return `<span class="cd-md-syntax">${list[0]}</span><span class="cd-md-checkbox">${task[1]}</span>${highlightMarkdownInline((task[2] ?? "") + (taskTail[1] ?? ""))}`;
    }
    const tail = /^(.*)$/.exec(rest);
    if (tail) return `<span class="cd-md-syntax">${list[0]}</span>${highlightMarkdownInline(tail[1] ?? "")}`;
  }

  return highlightMarkdownInline(escaped);
};

const highlightMarkdownInline = (escaped: string): string =>
  escaped
    .replace(
      /(`)([^`\n]+?)(`)/g,
      '<span class="cd-md-syntax">$1</span><span class="cd-md-code">$2</span><span class="cd-md-syntax">$3</span>',
    )
    .replace(/(\*\*)([^*\n]+?)(\*\*)/g, '<span class="cd-md-syntax">$1</span>$2<span class="cd-md-syntax">$3</span>')
    .replace(/(\[[^\]\n]+?\])(\([^)]+\))/g, '<span class="cd-md-link">$1</span><span class="cd-md-syntax">$2</span>')
    .replace(/(^|\s)(@[A-Za-z][\w-]*)/g, '$1<span class="cd-md-ref">$2</span>')
    .replace(/(#[A-Za-z][\w/-]*)/g, '<span class="cd-md-tag">$1</span>')
    .replace(/(=[A-Z][A-Z0-9_]*\([^)\n]*\))/g, '<span class="cd-md-formula">$1</span>');

export const highlightCodeDisplayLines = (code: string, language: CodeDisplayLanguage = "text"): string[] => {
  const lines = code.split("\n");
  if (language === "sql") return highlightSql(code).split("\n");

  if (language === "text") return lines.map((line) => escapeCodeHtml(line || " "));

  if (language === "markdown" || language === "md") {
    let fencedLanguage: string | undefined;
    return lines.map((line) => {
      const fence = /^```(\w*)/.exec(line);
      if (fence && /^.*$/.test(line.slice(fence[0].length))) {
        const highlightedFence = highlightMarkdownLine(line);
        fencedLanguage = fencedLanguage ? undefined : fence[1] || undefined;
        return highlightedFence;
      }
      return isCodeLanguage(fencedLanguage) ? (highlightCodeLines(line)[0] ?? "") || " " : highlightMarkdownLine(line || " ");
    });
  }

  if (lines.length >= 2 && /^```\w+/.test(lines[0] ?? "") && /^```\s*$/.test(lines[lines.length - 1] ?? "")) {
    const body = lines.slice(1, -1);
    const inner = body.length > 0 ? highlightCodeLines(body.join("\n")) : [];
    return [
      highlightMarkdownLine(lines[0] || " "),
      ...inner.map((line) => line || " "),
      highlightMarkdownLine(lines[lines.length - 1] || " "),
    ];
  }

  return highlightCodeLines(code).map((line) => line || " ");
};

const SQL_KEYWORDS = new Set(
  "SELECT WITH FROM WHERE AS AND OR NOT NULL IS IN BETWEEN LIKE ILIKE JOIN LEFT RIGHT INNER OUTER CROSS ON USING UNION ALL DISTINCT GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET CASE WHEN THEN ELSE END OVER PARTITION ROWS RANGE INTERVAL TRUE FALSE SETTINGS FORMAT".split(
    " ",
  ),
);

/** Display-only, tolerant of incomplete SQL while typing. Source is always escaped. */
export const highlightSql = (code: string): string => {
  // CodeDisplay puts each returned line into its own <code> element.
  const token = (kind: string, raw: string) =>
    raw
      .split("\n")
      .map((line) => wrap(kind, line))
      .join("\n");
  let out = "",
    i = 0;
  while (i < code.length) {
    const start = i,
      c = code[i]!;
    if (code.startsWith("--", i)) {
      const end = code.indexOf("\n", i);
      i = end < 0 ? code.length : end;
      out += token("cd-c", code.slice(start, i));
    } else if (code.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < code.length && depth) {
        if (code.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (code.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      out += token("cd-c", code.slice(start, i));
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < code.length) {
        if (code[i] === "\\") {
          i = Math.min(code.length, i + 2);
          continue;
        }
        if (code[i++] === c) {
          if (code[i] === c) {
            i++;
            continue;
          }
          break;
        }
      }
      out += token(c === "'" ? "cd-s" : "cd-p", code.slice(start, i));
    } else if (c === ":" && code[i - 1] !== ":" && !/[A-Za-z0-9_]/.test(code[i - 1] ?? "") && /[A-Za-z_]/.test(code[i + 1] ?? "")) {
      i += 2;
      while (/[A-Za-z0-9_]/.test(code[i] ?? "")) i++;
      out += token("cd-a cd-param", code.slice(start, i));
    } else if (/[A-Za-z_]/.test(c)) {
      i++;
      while (/[A-Za-z0-9_]/.test(code[i] ?? "")) i++;
      const word = code.slice(start, i);
      out += SQL_KEYWORDS.has(word.toUpperCase()) ? token("cd-k", word) : escapeCodeHtml(word);
    } else if (isDigit(c)) {
      i++;
      while (/[0-9.]/.test(code[i] ?? "")) i++;
      out += token("cd-n", code.slice(start, i));
    } else {
      out += escapeCodeHtml(c);
      i++;
    }
  }
  return out;
};
