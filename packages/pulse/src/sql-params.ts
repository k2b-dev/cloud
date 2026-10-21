/** Browser-safe SQL contract shared by the console, saved queries and the server. */
export const SQL_MAX_BYTES = 16 * 1024;
export const SQL_MAX_PARAMETERS = 32;
// Escaped + URL encoded String bytes take at most 6 bytes.
// 32 * 6 * 2048 = 393216; the remaining 128 KiB of the 512 KiB budget cover names,
// types, database, query_id and origin. SQL itself travels in the POST body.
export const SQL_PARAMETER_MAX_BYTES = 2 * 1024;
export const SQL_RESERVED_PARAMETERS = ["base_tz"] as const;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const word = (char: string | undefined) => char !== undefined && /[A-Za-z0-9_]/.test(char);
export type SqlToken = {
  kind: "comment" | "string" | "identifier" | "word" | "parameter" | "symbol" | "whitespace";
  start: number;
  end: number;
  text: string;
  depth: number;
};
export class SqlInputError extends Error {
  readonly status = 400;
  readonly line?: number;
  readonly column?: number;
  constructor(
    readonly code: "INPUT_TOO_LARGE" | "PARAMETER_MISSING" | "SQL_ERROR",
    message: string,
    source?: string,
    offset?: number,
  ) {
    super(message);
    if (source !== undefined && offset !== undefined) {
      const before = source.slice(0, offset);
      const lines = before.split(/\r\n|\r|\n/);
      this.line = lines.length;
      this.column = lines.at(-1)!.length + 1;
    }
  }
}

/** One pass; offsets are UTF-16 offsets suitable for editor/highlighter slices. */
export const scanSql = (source: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let at = 0,
    depth = 0;
  const reject = (message: string, offset = at): never => {
    throw new SqlInputError("SQL_ERROR", message, source, offset);
  };
  while (at < source.length) {
    const start = at,
      char = source[at]!;
    let kind: SqlToken["kind"] = "symbol";
    if (/\s/.test(char)) {
      kind = "whitespace";
      while (at < source.length && /\s/.test(source[at]!)) at++;
    } else if (source.startsWith("--", at)) {
      kind = "comment";
      while (at < source.length && source[at] !== "\n") at++;
    } else if (source.startsWith("/*", at)) {
      kind = "comment";
      at += 2;
      // ClickHouse supports nested block comments; preserve their nesting too.
      let nesting = 1;
      while (at < source.length && nesting) {
        if (source.startsWith("/*", at)) {
          nesting++;
          at += 2;
        } else if (source.startsWith("*/", at)) {
          nesting--;
          at += 2;
        } else at++;
      }
      if (nesting) reject("Unterminated block comment", start);
    } else if (char === "'" || char === '"' || char === "`") {
      kind = char === "'" ? "string" : "identifier";
      at++;
      let closed = false;
      while (at < source.length) {
        if (source[at] === "\\") {
          at += 2;
          continue;
        }
        if (source[at] === char) {
          if (source[at + 1] === char) {
            at += 2;
            continue;
          }
          at++;
          closed = true;
          break;
        }
        at++;
      }
      if (!closed) reject("Unterminated string or quoted identifier", start);
    } else if (char === ":" && source[at - 1] !== ":" && !word(source[at - 1]) && /[A-Za-z_]/.test(source[at + 1] ?? "")) {
      kind = "parameter";
      at += 2;
      while (word(source[at])) at++;
    } else if (/[A-Za-z_]/.test(char)) {
      kind = "word";
      at++;
      while (word(source[at])) at++;
    } else {
      if (char === "#" || char === "$") reject("Unsupported comment or heredoc syntax; use --, /* */ and quoted strings");
      if (char === "{") reject("Use :name parameters; raw ClickHouse bindings are not allowed");
      if (char === "(") depth++;
      if (char === ")" && --depth < 0) reject("Unexpected closing parenthesis");
      at++;
    }
    tokens.push({ kind, start, end: at, text: source.slice(start, at), depth: char === "(" ? depth - 1 : depth });
  }
  if (depth !== 0) reject("Unclosed parenthesis", source.length);
  return tokens;
};
export const sqlParameterNames = (source: string): string[] => [
  ...new Set(
    scanSql(source)
      .filter((token) => token.kind === "parameter")
      .map((token) => token.text.slice(1)),
  ),
];

export const validateSqlInput = (source: string, params: Record<string, string> = {}) => {
  if (typeof source !== "string" || bytes(source) > SQL_MAX_BYTES) throw new SqlInputError("INPUT_TOO_LARGE", "SQL text exceeds 16 KiB");
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new SqlInputError("SQL_ERROR", "Parameters must be a name to string map");
  const supplied = Object.entries(params);
  if (supplied.length > SQL_MAX_PARAMETERS) throw new SqlInputError("INPUT_TOO_LARGE", "At most 32 parameters are allowed");
  for (const [name, value] of supplied) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "base_tz")
      throw new SqlInputError("SQL_ERROR", "Invalid or reserved parameter name");
    if (typeof value !== "string" || bytes(value) > SQL_PARAMETER_MAX_BYTES)
      throw new SqlInputError("INPUT_TOO_LARGE", "Parameter values must be strings of at most 2 KiB");
  }
  const tokens = scanSql(source);
  const meaningful = tokens.filter((token) => token.kind !== "whitespace" && token.kind !== "comment");
  const first = meaningful.find((token) => token.text !== "(");
  if (!first || first.kind !== "word" || !/^(SELECT|WITH)$/i.test(first.text))
    throw new SqlInputError("SQL_ERROR", "Only SELECT or WITH queries are allowed", source, first?.start ?? 0);
  for (const [index, token] of meaningful.entries()) {
    if (token.text === ";" && (index !== meaningful.length - 1 || token.depth !== 0))
      throw new SqlInputError("SQL_ERROR", "Only one trailing semicolon is allowed", source, token.start);
    if (token.kind === "word" && token.depth === 0 && /^(FORMAT|SETTINGS)$/i.test(token.text) && meaningful[index + 1]?.text !== "(")
      throw new SqlInputError("SQL_ERROR", "Top-level FORMAT and SETTINGS are not allowed", source, token.start);
    if (
      token.kind === "word" &&
      /^INTO$/i.test(token.text) &&
      meaningful[index + 1]?.kind === "word" &&
      /^OUTFILE$/i.test(meaningful[index + 1]!.text)
    )
      throw new SqlInputError("SQL_ERROR", "INTO OUTFILE is not allowed", source, token.start);
  }
  const names = [...new Set(tokens.filter((token) => token.kind === "parameter").map((token) => token.text.slice(1)))];
  if (names.filter((name) => name !== "base_tz").length > SQL_MAX_PARAMETERS)
    throw new SqlInputError("INPUT_TOO_LARGE", "At most 32 parameters are allowed");
  for (const name of names) {
    if (name !== "base_tz" && !Object.hasOwn(params, name)) {
      const offset = tokens.find((token) => token.kind === "parameter" && token.text === `:${name}`)!.start;
      throw new SqlInputError("PARAMETER_MISSING", `Missing value for :${name}`, source, offset);
    }
  }
  if (supplied.some(([name]) => !names.includes(name))) throw new SqlInputError("SQL_ERROR", "Unused parameter values are not allowed");
  const trailing = meaningful.at(-1);
  const sql = trailing?.text === ";" ? source.slice(0, trailing.start) + source.slice(trailing.end) : source;
  return { sql, names, tokens };
};
export type SqlBinding = { type: string; value: string };
export const bindSqlValue = (value: string, timezone: string): SqlBinding => {
  // Zone-free date-times are wall times in the base timezone, not in the
  // server process timezone. ClickHouse parses the bound value in its type.
  const local = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value);
  if (local && Number.isFinite(Date.parse(value.replace(" ", "T") + "Z")))
    return { type: `DateTime64(3, '${timezone}')`, value: value.replace("T", " ") };
  const date = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value);
  if (date && Number.isFinite(Date.parse(value))) {
    // Explicit instants use decimal Unix seconds, avoiding an ambiguous local
    // time during the repeated autumn hour. Date-only input is local midnight.
    return {
      type: `DateTime64(3, '${timezone}')`,
      value: value.length === 10 ? `${value} 00:00:00.000` : (Date.parse(value) / 1000).toFixed(3),
    };
  }
  const duration = /^(\d+)(s|m|h|d|w)$/.exec(value);
  if (duration) {
    const scale = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[duration[2]!]!;
    const seconds = Number(duration[1]) * scale;
    if (!Number.isSafeInteger(seconds) || seconds > 4294967295) throw new SqlInputError("SQL_ERROR", "Duration exceeds UInt32 seconds");
    return { type: "UInt32", value: String(seconds) };
  }
  if (value.trim() !== "" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)))
    return { type: "Float64", value: String(Number(value)) };
  return { type: "String", value };
};
// HTTP query parameters of type String use ClickHouse's Escaped input format,
// after URL decoding. Escape only String bindings, not typed numeric/date fields.
export const escapeSqlStringParameter = (value: string): string =>
  value.replace(
    /[\\\0\b\f\n\r\t]/g,
    (character) => ({ "\\": "\\\\", "\0": "\\0", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" })[character]!,
  );
export const prepareSql = (source: string, supplied: Record<string, string> = {}, timezone = "UTC") => {
  // The timezone becomes a type annotation, so check its syntax before interpolation.
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new SqlInputError("SQL_ERROR", "Invalid base timezone");
  }
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timezone)) throw new SqlInputError("SQL_ERROR", "Invalid base timezone");
  const checked = validateSqlInput(source, supplied);
  const bindings = new Map(
    checked.names.map((name) => [name, name === "base_tz" ? { type: "String", value: timezone } : bindSqlValue(supplied[name]!, timezone)]),
  );
  let sql = "",
    offset = 0;
  // Rescan the semicolon-stripped source to retain offsets even before comments.
  for (const token of scanSql(checked.sql)) {
    if (token.kind !== "parameter") continue;
    const name = token.text.slice(1);
    sql += checked.sql.slice(offset, token.start) + `{${name}:${bindings.get(name)!.type}}`;
    offset = token.end;
  }
  sql += checked.sql.slice(offset);
  return {
    sql,
    params: Object.fromEntries(
      [...bindings].map(([name, binding]) => [name, binding.type === "String" ? escapeSqlStringParameter(binding.value) : binding.value]),
    ),
  };
};
