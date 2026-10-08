// Module specifiers in app JavaScript. A small scanner skips comments, strings,
// template literals and regular expressions, so import-like text in them is no
// import. The composer lints with it and the prelude rewrites with it: both
// see the same imports.

/** One specifier; `start` and `end` cover its text without the quotes. */
export type Specifier = { start: number; end: number; value: string };

/** Keywords after which `/` starts a regular expression instead of a division. */
const BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const SPACE = " \t\n\r\v\f ﻿  ";
const isIdStart = (c: string) => /[A-Za-z_$]/.test(c) || (c > "\x7f" && !SPACE.includes(c));
const isId = (c: string) => /[\w$]/.test(c) || (c > "\x7f" && !SPACE.includes(c));

/** Specifiers of static imports, re-exports and `import("…")` calls, in source order. */
export function moduleSpecifiers(source: string): Specifier[] {
  const found: Specifier[] = [];
  const n = source.length;
  /** Brace depths at which a template literal continues after its `${…}`. */
  const templates: number[] = [];
  let depth = 0;
  let i = 0;
  /** The last significant token: a word or one punctuation character; a literal counts as `)`, a value before a division. */
  let last = "";

  const commentEnd = (j: number) => {
    if (source[j + 1] === "/") {
      const end = source.indexOf("\n", j);
      return end < 0 ? n : end;
    }
    const end = source.indexOf("*/", j + 2);
    return end < 0 ? n : end + 2;
  };
  /** The next index that is no whitespace or comment. */
  const next = (j: number) => {
    while (j < n) {
      if (SPACE.includes(source[j]!)) j++;
      else if (source[j] === "/" && (source[j + 1] === "/" || source[j + 1] === "*")) j = commentEnd(j);
      else break;
    }
    return j;
  };
  /** The end of the string literal that opens at `j`; a string never spans a line. */
  const stringEnd = (j: number) => {
    const quote = source[j];
    for (j++; j < n; j++) {
      if (source[j] === "\\") j++;
      else if (source[j] === quote) return j + 1;
      else if (source[j] === "\n") return j;
    }
    return n;
  };
  const regexEnd = (j: number) => {
    let inClass = false;
    for (j++; j < n; j++) {
      const c = source[j];
      if (c === "\\") j++;
      else if (c === "\n") return j;
      else if (inClass) inClass = c !== "]";
      else if (c === "[") inClass = true;
      else if (c === "/") {
        for (j++; j < n && isId(source[j]!); j++);
        return j;
      }
    }
    return n;
  };
  const isQuote = (j: number) => source[j] === '"' || source[j] === "'";
  const record = (j: number) => {
    const end = stringEnd(j);
    if (end - j >= 2 && source[end - 1] === source[j]) found.push({ start: j + 1, end: end - 1, value: source.slice(j + 1, end - 1) });
  };
  /** Continues a template literal at `i` up to its end or its next `${`. */
  const template = () => {
    for (; i < n; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === "`") {
        i++;
        last = ")";
        return;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        templates.push(depth);
        i += 2;
        last = "{";
        return;
      }
    }
  };

  while (i < n) {
    const c = source[i]!;
    if (SPACE.includes(c)) i++;
    else if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) i = commentEnd(i);
    else if (c === '"' || c === "'") {
      i = stringEnd(i);
      last = ")";
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "/") {
      const regex = !last || (isIdStart(last[0]!) ? BEFORE_REGEX.has(last) : last !== ")" && last !== "]");
      i = regex ? regexEnd(i) : i + 1;
      last = regex ? ")" : "/";
    } else if (isIdStart(c)) {
      let end = i + 1;
      while (end < n && isId(source[end]!)) end++;
      const word = source.slice(i, end);
      // `from "…"` only occurs in imports and re-exports; `obj.from` and `obj.import` are properties.
      if (last !== "." && (word === "from" || word === "import")) {
        const at = next(end);
        if (isQuote(at)) record(at);
        else if (word === "import" && source[at] === "(") {
          const argument = next(at + 1);
          const after = isQuote(argument) ? next(stringEnd(argument)) : -1;
          if (source[after] === ")" || source[after] === ",") record(argument);
        }
      }
      last = word;
      i = end;
    } else if ((c === "+" || c === "-") && source[i + 1] === c) {
      // After a value, `++` and `--` are postfix and the value continues: `n++ / 2` divides.
      const value = !!last && (isIdStart(last[0]!) ? !BEFORE_REGEX.has(last) : last === ")" || last === "]");
      i += 2;
      last = value ? ")" : c;
    } else if (/\d/.test(c)) {
      for (i++; i < n && /[\w.]/.test(source[i]!); i++);
      last = ")";
    } else {
      i++;
      if (c === "{") depth++;
      else if (c === "}" && templates.at(-1) === depth) {
        templates.pop();
        template();
        continue;
      } else if (c === "}") depth--;
      last = c;
    }
  }
  return found;
}
