/**
 * Small safe highlighters for CodeDisplay.
 *
 * These are display-only highlighters: no AST, no runtime parser, no
 * dependency. Every input character is HTML-escaped before being wrapped
 * in token spans, so the returned strings are safe to inject with
 * `innerHTML`.
 */

const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "import",
  "from",
  "export",
  "default",
  "async",
  "await",
  "new",
  "true",
  "false",
  "null",
  "undefined",
  "as",
  "type",
  "interface",
  "void",
  "this",
  "typeof",
  "in",
  "of",
]);

export type CodeDisplayLanguage = "ts" | "tsx" | "js" | "jsx" | "script" | "markdown" | "md" | "text" | "sql";

export const escapeCodeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdCont = (c: string): boolean => /[\w$]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);
const wrap = (cls: string, raw: string): string => `<span class="${cls}">${escapeCodeHtml(raw)}</span>`;
const isCodeLanguage = (language: string | undefined): boolean =>
  language === "script" || language === "js" || language === "jsx" || language === "ts" || language === "tsx";

export const highlightCode = (code: string): string => {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i]!;

    if (c === "/" && code[i + 1] === "/") {
      const nl = code.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      out += wrap("cd-c", code.slice(i, end));
      i = end;
      continue;
    }

    if (c === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? n : close + 2;
      out += wrap("cd-c", code.slice(i, end));
      i = end;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += wrap("cd-s", code.slice(i, j));
      i = j;
      continue;
    }

    if (isDigit(c)) {
      let j = i;
      while (j < n && (isDigit(code[j]!) || code[j] === ".")) j++;
      out += wrap("cd-n", code.slice(i, j));
      i = j;
      continue;
    }

    if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdCont(code[j]!)) j++;
      const word = code.slice(i, j);
      let cls = "";
      if (KEYWORDS.has(word)) cls = "cd-k";
      else if (/^[A-Z]/.test(word)) cls = "cd-p";
      else {
        let k = j;
        while (k < n && code[k] === " ") k++;
        const next = code[k];
        const prev = i > 0 ? code[i - 1] : "";
        const assignment = next === "=" && code[k + 1] !== "=" && code[k + 1] !== ">";
        const objectKey = next === ":";
        const functionCall = next === "(";
        const property = prev === ".";
        if (assignment || objectKey) cls = "cd-a";
        else if (functionCall || property) cls = "cd-f";
      }
      out += cls ? wrap(cls, word) : escapeCodeHtml(word);
      i = j;
      continue;
    }

    out += escapeCodeHtml(c);
    i++;
  }

  return out;
};

const highlightMarkdownLine = (line: string): string => {
  const escaped = escapeCodeHtml(line);

  const heading = /^(#{1,6})(\s.*)$/.exec(escaped);
  if (heading) return `<span class="cd-md-syntax">${heading[1]}</span>${highlightMarkdownInline(heading[2] ?? "")}`;

  const ref = /^(@[A-Za-z][\w-]*)$/.exec(escaped);
  if (ref) return `<span class="cd-md-ref">${ref[1]}</span>`;

  const directive = /^(\s*:::)([A-Za-z][\w-]*)?(.*)$/.exec(escaped);
  if (directive) {
    const name = directive[2] ? `<span class="cd-md-directive">${directive[2]}</span>` : "";
    return `${directive[1] ? `<span class="cd-md-syntax">${directive[1]}</span>` : ""}${name}${highlightMarkdownInline(directive[3] ?? "")}`;
  }

  const fence = /^(```)(.*)$/.exec(escaped);
  if (fence) {
    const language = fence[2] ? `<span class="cd-md-ref">${fence[2]}</span>` : "";
    return `<span class="cd-md-syntax">${fence[1]}</span>${language}`;
  }

  const table = /^(\s*\|)(.*)(\|\s*)$/.exec(escaped);
  if (table) return `<span class="cd-md-syntax">${table[1]}</span>${table[2]}<span class="cd-md-syntax">${table[3]}</span>`;

  const task = /^(\s*(?:[-*+]|\d+\.)\s+)(\[[ xX]\])(\s+.*)$/.exec(escaped);
  if (task) {
    return `<span class="cd-md-syntax">${task[1]}</span><span class="cd-md-checkbox">${task[2]}</span>${highlightMarkdownInline(task[3] ?? "")}`;
  }

  const list = /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/.exec(escaped);
  if (list) return `<span class="cd-md-syntax">${list[1]}</span>${highlightMarkdownInline(list[2] ?? "")}`;

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

export const highlightMarkdownDisplay = (code: string): string => code.split("\n").map(highlightMarkdownLine).join("\n");

export const highlightCodeDisplayLines = (code: string, language: CodeDisplayLanguage = "text"): string[] => {
  const lines = code.split("\n");
  if (language === "sql") return highlightSql(code).split("\n");

  if (language === "text") return lines.map((line) => escapeCodeHtml(line || " "));

  if (language === "markdown" || language === "md") {
    let fencedLanguage: string | undefined;
    return lines.map((line) => {
      const fence = /^(```)(\w+)?(.*)$/.exec(line);
      if (fence) {
        const highlightedFence = highlightMarkdownLine(line);
        fencedLanguage = fencedLanguage ? undefined : fence[2];
        return highlightedFence;
      }
      return isCodeLanguage(fencedLanguage) ? highlightCode(line || " ") : highlightMarkdownLine(line || " ");
    });
  }

  if (lines.length >= 2 && /^```\w+/.test(lines[0] ?? "") && /^```\s*$/.test(lines[lines.length - 1] ?? "")) {
    return lines.map((line, index) => {
      if (index === 0 || index === lines.length - 1) return highlightMarkdownLine(line || " ");
      return highlightCode(line || " ");
    });
  }

  return lines.map((line) => highlightCode(line || " "));
};

export const highlightCodeDisplay = (code: string, language: CodeDisplayLanguage = "text"): string => {
  if (language === "sql") return highlightSql(code);
  if (code.includes("\n")) return highlightCodeDisplayLines(code, language).join("\n");
  if (language === "markdown" || language === "md") return highlightMarkdownDisplay(code);
  if (language === "text") return escapeCodeHtml(code);
  return highlightCode(code);
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
      out += token("cd-a", code.slice(start, i));
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
