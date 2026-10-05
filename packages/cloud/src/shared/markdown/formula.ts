/**
 * Markdown table formula language — pure-TS lexer + parser + evaluator.
 *
 * Used by both the `marked` extension (server-side render) and the
 * notebooks CodeMirror table widget (client-side preview). Keep the
 * file dependency-free so both runtimes can import it as-is.
 *
 * Public API:
 *
 *   evaluateFormula(source: string, ctx: EvalContext): EvalResult
 *
 * `source` is a cell value starting with `=` (the leading `=` is
 * stripped before parsing). `ctx` describes the surrounding table
 * and the cell's position. Result is `{ kind: "ok", value }` or
 * `{ kind: "error", code, message, suggestion? }` — the renderer
 * decides how to display each.
 *
 * See `formula.test.ts` for the full behaviour surface.
 */

// =============================================================================
// Public types
// =============================================================================

export type EvalContext = {
  /** Header row (column names). */
  headers: string[];
  /** Body rows. Each row's length should match `headers.length`. */
  rows: string[][];
  /** Index of the row the formula is currently being evaluated for. */
  currentRow: number;
  /** Index of the column the formula is currently being evaluated for. */
  currentCol: number;
  /** @internal Cells `(row,col)` currently being evaluated — propagated
   *  through recursive formula-in-formula resolution to detect cycles. */
  _visited?: ReadonlySet<string>;
};

export type EvalValue = number | string | boolean;

export type ErrorCode =
  | "PARSE_ERROR"
  | "UNKNOWN_FUNCTION"
  | "UNKNOWN_COLUMN"
  | "WRONG_ARG_COUNT"
  | "NON_NUMERIC"
  | "DIV_BY_ZERO"
  | "TYPE_ERROR"
  | "CIRCULAR_REF";

export type EvalError = {
  kind: "error";
  code: ErrorCode;
  message: string;
  /** A close-by valid name for typo errors — surface in the UI hover. */
  suggestion?: string;
};

export type EvalResult = { kind: "ok"; value: EvalValue } | EvalError;

export type ProgressValue = {
  ratio: number;
  label: string;
};

const ok = (value: EvalValue): EvalResult => ({ kind: "ok", value });
const err = (code: ErrorCode, message: string, suggestion?: string): EvalError => ({ kind: "error", code, message, suggestion });

const PROGRESS_VALUE_RE = /^__progress:([^:]+):(.+)__$/;

const clampProgress = (ratio: number): number => Math.max(0, Math.min(1, ratio));

export const createProgressValue = (ratio: number, label: string): string =>
  `__progress:${clampProgress(ratio)}:${encodeURIComponent(label)}__`;

export const parseProgressValue = (value: EvalValue): ProgressValue | null => {
  if (typeof value !== "string") return null;
  const match = value.match(PROGRESS_VALUE_RE);
  if (!match) return null;
  const ratio = Number.parseFloat(match[1]!);
  if (Number.isNaN(ratio)) return null;
  return {
    ratio: clampProgress(ratio),
    label: decodeURIComponent(match[2]!),
  };
};

// =============================================================================
// Lexer
// =============================================================================

type TokenKind =
  | "NUMBER"
  | "STRING"
  | "IDENT"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "EQ"
  | "NEQ"
  | "LT"
  | "LTE"
  | "GT"
  | "GTE"
  | "EOF";

type Token = { kind: TokenKind; value: string; pos: number };

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdentStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentChar = (c: string) => isIdentStart(c) || isDigit(c);

const tokenize = (source: string): Token[] | EvalError => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "LPAREN", value: "(", pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "RPAREN", value: ")", pos: i });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ kind: "COMMA", value: ",", pos: i });
      i++;
      continue;
    }
    if (c === "+") {
      tokens.push({ kind: "PLUS", value: "+", pos: i });
      i++;
      continue;
    }
    if (c === "-") {
      tokens.push({ kind: "MINUS", value: "-", pos: i });
      i++;
      continue;
    }
    if (c === "*") {
      tokens.push({ kind: "STAR", value: "*", pos: i });
      i++;
      continue;
    }
    if (c === "/") {
      tokens.push({ kind: "SLASH", value: "/", pos: i });
      i++;
      continue;
    }
    if (c === "=" && source[i + 1] === "=") {
      tokens.push({ kind: "EQ", value: "==", pos: i });
      i += 2;
      continue;
    }
    if (c === "!" && source[i + 1] === "=") {
      tokens.push({ kind: "NEQ", value: "!=", pos: i });
      i += 2;
      continue;
    }
    if (c === "<" && source[i + 1] === "=") {
      tokens.push({ kind: "LTE", value: "<=", pos: i });
      i += 2;
      continue;
    }
    if (c === "<") {
      tokens.push({ kind: "LT", value: "<", pos: i });
      i++;
      continue;
    }
    if (c === ">" && source[i + 1] === "=") {
      tokens.push({ kind: "GTE", value: ">=", pos: i });
      i += 2;
      continue;
    }
    if (c === ">") {
      tokens.push({ kind: "GT", value: ">", pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      // String literal. Supports \" and \\ escapes — KISS, no \n or other.
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\" && j + 1 < source.length) {
          const next = source[j + 1]!;
          if (next === '"' || next === "\\") {
            value += next;
            j += 2;
            continue;
          }
        }
        value += source[j];
        j++;
      }
      if (j >= source.length) {
        return err("PARSE_ERROR", `Unterminated string starting at position ${i}`);
      }
      tokens.push({ kind: "STRING", value, pos: i });
      i = j + 1;
      continue;
    }
    if (c === "`") {
      // Backtick-quoted identifier. Used to reference column names that
      // contain spaces or special characters: `=SUM(\`Tax (19%)\`)`.
      // Same escape rules as strings (\` and \\).
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== "`") {
        if (source[j] === "\\" && j + 1 < source.length) {
          const next = source[j + 1]!;
          if (next === "`" || next === "\\") {
            value += next;
            j += 2;
            continue;
          }
        }
        value += source[j];
        j++;
      }
      if (j >= source.length) {
        return err("PARSE_ERROR", `Unterminated backtick-quoted identifier starting at position ${i}`);
      }
      tokens.push({ kind: "IDENT", value, pos: i });
      i = j + 1;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length && isDigit(source[j]!)) j++;
      if (source[j] === ".") {
        j++;
        while (j < source.length && isDigit(source[j]!)) j++;
      }
      tokens.push({ kind: "NUMBER", value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < source.length && isIdentChar(source[j]!)) j++;
      tokens.push({ kind: "IDENT", value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }
    return err("PARSE_ERROR", `Unexpected character "${c}" at position ${i}`);
  }
  tokens.push({ kind: "EOF", value: "", pos: source.length });
  return tokens;
};

// =============================================================================
// Parser — recursive descent
// =============================================================================

type BinOp = "+" | "-" | "*" | "/" | "==" | "!=" | "<" | "<=" | ">" | ">=";

type AST =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "col"; name: string }
  | { kind: "call"; name: string; args: AST[] }
  | { kind: "binop"; op: BinOp; left: AST; right: AST }
  | { kind: "neg"; operand: AST };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private advance(): Token {
    return this.tokens[this.pos++]!;
  }

  parse(): AST | EvalError {
    try {
      const expr = this.parseExpr();
      if (this.peek().kind !== "EOF") {
        return err("PARSE_ERROR", `Unexpected "${this.peek().value}" after end of formula`);
      }
      return expr;
    } catch (e) {
      if (e instanceof Error) return err("PARSE_ERROR", e.message);
      return err("PARSE_ERROR", String(e));
    }
  }

  // expr := compareExpr
  private parseExpr(): AST {
    return this.parseCompare();
  }

  // compareExpr := addExpr (('==' | '!=' | '<' | '<=' | '>' | '>=') addExpr)*
  private parseCompare(): AST {
    let left = this.parseAdd();
    while (true) {
      const k = this.peek().kind;
      let op: BinOp | null = null;
      if (k === "EQ") op = "==";
      else if (k === "NEQ") op = "!=";
      else if (k === "LT") op = "<";
      else if (k === "LTE") op = "<=";
      else if (k === "GT") op = ">";
      else if (k === "GTE") op = ">=";
      if (!op) break;
      this.advance();
      const right = this.parseAdd();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  // addExpr := mulExpr (('+' | '-') mulExpr)*
  private parseAdd(): AST {
    let left = this.parseMul();
    while (true) {
      const k = this.peek().kind;
      if (k !== "PLUS" && k !== "MINUS") break;
      const op: BinOp = k === "PLUS" ? "+" : "-";
      this.advance();
      const right = this.parseMul();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  // mulExpr := unaryExpr (('*' | '/') unaryExpr)*
  private parseMul(): AST {
    let left = this.parseUnary();
    while (true) {
      const k = this.peek().kind;
      if (k !== "STAR" && k !== "SLASH") break;
      const op: BinOp = k === "STAR" ? "*" : "/";
      this.advance();
      const right = this.parseUnary();
      left = { kind: "binop", op, left, right };
    }
    return left;
  }

  // unaryExpr := '-' unaryExpr | primary
  private parseUnary(): AST {
    if (this.peek().kind === "MINUS") {
      this.advance();
      return { kind: "neg", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  // primary := NUMBER | STRING | IDENT | IDENT '(' arglist? ')' | '(' expr ')'
  private parsePrimary(): AST {
    const tok = this.peek();
    if (tok.kind === "NUMBER") {
      this.advance();
      return { kind: "num", value: Number.parseFloat(tok.value) };
    }
    if (tok.kind === "STRING") {
      this.advance();
      return { kind: "str", value: tok.value };
    }
    if (tok.kind === "LPAREN") {
      this.advance();
      const inner = this.parseExpr();
      if (this.peek().kind !== "RPAREN") {
        throw new Error(`Expected ")" after expression`);
      }
      this.advance();
      return inner;
    }
    if (tok.kind === "IDENT") {
      this.advance();
      if (this.peek().kind === "LPAREN") {
        this.advance();
        const args: AST[] = [];
        if (this.peek().kind !== "RPAREN") {
          args.push(this.parseExpr());
          while (this.peek().kind === "COMMA") {
            this.advance();
            args.push(this.parseExpr());
          }
        }
        if (this.peek().kind !== "RPAREN") {
          throw new Error(`Expected ")" or "," in function call to "${tok.value}"`);
        }
        this.advance();
        return { kind: "call", name: tok.value, args };
      }
      return { kind: "col", name: tok.value };
    }
    if (tok.kind === "EOF") {
      throw new Error(`Unexpected end of formula`);
    }
    throw new Error(`Unexpected "${tok.value}" at position ${tok.pos}`);
  }
}

// =============================================================================
// Did-you-mean — Levenshtein-distance suggestion
// =============================================================================

const levenshtein = (a: string, b: string): number => {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array<number>(bl + 1);
  const curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= bl; j++) prev[j] = curr[j]!;
  }
  return prev[bl]!;
};

const findClosest = (target: string, options: string[], maxDistance = 2): string | undefined => {
  let best: string | undefined;
  let bestD = maxDistance + 1;
  const t = target.toLowerCase();
  for (const opt of options) {
    const d = levenshtein(t, opt.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = opt;
    }
  }
  return best;
};

// =============================================================================
// Evaluator
// =============================================================================

const isNumeric = (v: EvalValue): v is number => typeof v === "number" && !Number.isNaN(v);

const toNumber = (v: EvalValue): number | null => {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number.parseFloat(trimmed);
    return Number.isNaN(n) ? null : n;
  }
  return null;
};

const toString = (v: EvalValue): string => {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
};

const isTruthy = (v: EvalValue): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  return v.length > 0;
};

/** Cell text that is one decimal number and nothing else. Each digit has
 *  one place in the pattern, so a long run of digits never backtracks. */
const NUMBER_CELL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

/** A number, boolean, or text whose whole content is one number. */
const toExactNumber = (v: EvalValue): number | null =>
  typeof v === "string" ? (NUMBER_CELL.test(v.trim()) ? Number(v.trim()) : null) : toNumber(v);

/** An ISO date or timestamp: `2026-10-12`, `2026-10-12 09:30`,
 *  `2026-10-12T09:30:00.250Z`, or with an offset such as `+02:00`. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

/** An ISO date without a time, such as `2026-10-12`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant an ISO date or timestamp names, or null for anything else,
 * including impossible dates such as `2026-02-30`. Text without an offset
 * is local time, like the values TODAY() and NOW() return.
 */
const toDateTime = (v: EvalValue): number | null => {
  if (typeof v !== "string") return null;
  const match = ISO_DATE_TIME.exec(v.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const ms = Number((match[7] ?? "").padEnd(3, "0"));
  const zone = match[8];
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  if (zone) {
    utc.setUTCHours(hour, minute, second, ms);
    if (zone.toUpperCase() === "Z") return utc.getTime();
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    return utc.getTime() - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  const local = new Date(0);
  local.setFullYear(year, month - 1, day);
  local.setHours(hour, minute, second, ms);
  return local.getTime();
};

/**
 * Equality for `==`, `!=`, COUNTIF, and SUMIF: dates by instant; numbers,
 * also `5 €` against 5, by value; everything else, such as `1.2.3` or
 * `3 apples`, by its exact text.
 */
const isEqual = (l: EvalValue, r: EvalValue): boolean => {
  const ld = toDateTime(l);
  const rd = toDateTime(r);
  if (ld !== null && rd !== null) return ld === rd;
  if (ld === null && rd === null && (toExactNumber(l) !== null || toExactNumber(r) !== null)) {
    const ln = toNumber(l);
    const rn = toNumber(r);
    if (ln !== null && rn !== null) return ln === rn;
  }
  return toString(l) === toString(r);
};

const lookupColumn = (name: string, ctx: EvalContext): { index: number } | { suggestion?: string } => {
  const lower = name.toLowerCase();
  const idx = ctx.headers.findIndex((h) => h.toLowerCase() === lower);
  if (idx !== -1) return { index: idx };
  return { suggestion: findClosest(name, ctx.headers) };
};

const cellAt = (row: number, col: number, ctx: EvalContext): string => {
  return ctx.rows[row]?.[col] ?? "";
};

const isCurrentFormulaCell = (row: number, col: number, ctx: EvalContext): boolean =>
  row === ctx.currentRow && col === ctx.currentCol && cellAt(row, col, ctx).startsWith("=");

/**
 * Resolve a single cell to its evaluated value. If the cell is itself
 * a formula, recursively evaluate it (with cycle detection via
 * `ctx._visited`). A non-formula cell becomes a number only when its
 * whole text is one; anything else, such as the ISO date `2026-10-12`
 * that DATEDIFF needs intact, stays text.
 *
 * Used by both the column-reference resolver in `evaluateAst` and by
 * the column / row aggregate functions, so a `=SUM(total)` aggregating
 * a column that's itself filled with `=hours * rate` formulas computes
 * the chain correctly instead of seeing the literal formula strings.
 */
const evaluateCell = (row: number, col: number, ctx: EvalContext): EvalResult => {
  const cell = cellAt(row, col, ctx);
  if (!cell.startsWith("=")) {
    const text = cell.trim();
    return NUMBER_CELL.test(text) ? ok(Number(text)) : ok(cell);
  }
  const key = `${row},${col}`;
  if (ctx._visited?.has(key)) {
    const colName = ctx.headers[col] ?? `col ${col}`;
    return err("CIRCULAR_REF", `Circular reference involving "${colName}" at row ${row + 1}`);
  }
  const visited = new Set<string>(ctx._visited ?? []);
  visited.add(key);
  return evaluateFormula(cell, {
    ...ctx,
    currentRow: row,
    currentCol: col,
    _visited: visited,
  });
};

type EvalState = {
  ctx: EvalContext;
  evaluate: (ast: AST) => EvalResult;
};

// -- Function implementations -------------------------------------------------

type FuncImpl = (args: AST[], state: EvalState) => EvalResult;

const argCountError = (name: string, expected: string, got: number): EvalError =>
  err("WRONG_ARG_COUNT", `${name} expects ${expected}, got ${got}`);

/** Resolve a column-name AST argument and gather every row's value
 *  for that column — formulas are recursively evaluated, errors are
 *  silently skipped (won't propagate up) so an aggregate over a
 *  partially-broken column still produces a meaningful number. */
const collectColumnValues = (arg: AST, state: EvalState): { values: string[] } | EvalError => {
  if (arg.kind !== "col") {
    return err("TYPE_ERROR", `Expected a column name, got ${arg.kind === "num" ? "number" : "value"}`);
  }
  const lookup = lookupColumn(arg.name, state.ctx);
  if (!("index" in lookup)) {
    return err(
      "UNKNOWN_COLUMN",
      `Unknown column "${arg.name}"${lookup.suggestion ? ` — did you mean "${lookup.suggestion}"?` : ""}`,
      lookup.suggestion,
    );
  }
  const values: string[] = [];
  for (let r = 0; r < state.ctx.rows.length; r++) {
    if (isCurrentFormulaCell(r, lookup.index, state.ctx)) continue;
    const result = evaluateCell(r, lookup.index, state.ctx);
    if (result.kind === "ok") values.push(toString(result.value));
    // errored cells silently skipped — same handling as non-numeric cells
  }
  return { values };
};

/** Map raw cell strings to numbers, dropping empties / non-numeric. */
const numericColumnValues = (values: string[]): number[] => {
  const out: number[] = [];
  for (const v of values) {
    const n = toNumber(v);
    if (n !== null) out.push(n);
  }
  return out;
};

const aggregateColumn = (name: string, args: AST[], state: EvalState, fn: (nums: number[]) => number | EvalError): EvalResult => {
  if (args.length !== 1) return argCountError(name, "1 argument (column name)", args.length);
  const col = collectColumnValues(args[0]!, state);
  if ("kind" in col) return col;
  const nums = numericColumnValues(col.values);
  const result = fn(nums);
  if (typeof result === "number") return ok(result);
  return result;
};

const FUNCTIONS: Record<string, FuncImpl> = {
  // --- Math ---
  ROUND: (args, state) => {
    if (args.length !== 2) return argCountError("ROUND", "2 arguments (number, digits)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    const d = state.evaluate(args[1]!);
    if (d.kind === "error") return d;
    const n = toNumber(v.value);
    if (n === null) return err("NON_NUMERIC", `ROUND: first argument is not a number`);
    const digits = toNumber(d.value);
    if (digits === null) return err("NON_NUMERIC", `ROUND: digits argument is not a number`);
    const factor = Math.pow(10, Math.floor(digits));
    return ok(Math.round(n * factor) / factor);
  },
  ABS: (args, state) => {
    if (args.length !== 1) return argCountError("ABS", "1 argument (number)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    const n = toNumber(v.value);
    if (n === null) return err("NON_NUMERIC", `ABS: argument is not a number`);
    return ok(Math.abs(n));
  },
  SQRT: (args, state) => {
    if (args.length !== 1) return argCountError("SQRT", "1 argument (number)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    const n = toNumber(v.value);
    if (n === null) return err("NON_NUMERIC", `SQRT: argument is not a number`);
    if (n < 0) return err("NON_NUMERIC", `SQRT: argument must be non-negative (got ${n})`);
    return ok(Math.sqrt(n));
  },
  POW: (args, state) => {
    if (args.length !== 2) return argCountError("POW", "2 arguments (base, exponent)", args.length);
    const baseV = state.evaluate(args[0]!);
    if (baseV.kind === "error") return baseV;
    const expV = state.evaluate(args[1]!);
    if (expV.kind === "error") return expV;
    const base = toNumber(baseV.value);
    const exp = toNumber(expV.value);
    if (base === null) return err("NON_NUMERIC", `POW: base is not a number`);
    if (exp === null) return err("NON_NUMERIC", `POW: exponent is not a number`);
    return ok(Math.pow(base, exp));
  },
  MOD: (args, state) => {
    if (args.length !== 2) return argCountError("MOD", "2 arguments (a, b)", args.length);
    const aV = state.evaluate(args[0]!);
    if (aV.kind === "error") return aV;
    const bV = state.evaluate(args[1]!);
    if (bV.kind === "error") return bV;
    const a = toNumber(aV.value);
    const b = toNumber(bV.value);
    if (a === null) return err("NON_NUMERIC", `MOD: first argument is not a number`);
    if (b === null) return err("NON_NUMERIC", `MOD: second argument is not a number`);
    if (b === 0) return err("DIV_BY_ZERO", `MOD: divisor is zero`);
    return ok(a % b);
  },

  // --- Column aggregates ---
  SUM: (args, state) => aggregateColumn("SUM", args, state, (nums) => nums.reduce((a, b) => a + b, 0)),
  AVG: (args, state) =>
    aggregateColumn("AVG", args, state, (nums) => (nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length)),
  MIN: (args, state) => aggregateColumn("MIN", args, state, (nums) => (nums.length === 0 ? 0 : Math.min(...nums))),
  MAX: (args, state) => aggregateColumn("MAX", args, state, (nums) => (nums.length === 0 ? 0 : Math.max(...nums))),
  COUNT: (args, state) => {
    if (args.length !== 1) return argCountError("COUNT", "1 argument (column name)", args.length);
    const col = collectColumnValues(args[0]!, state);
    if ("kind" in col) return col;
    return ok(col.values.filter((v) => v.trim().length > 0).length);
  },
  MEDIAN: (args, state) =>
    aggregateColumn("MEDIAN", args, state, (nums) => {
      if (nums.length === 0) return 0;
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    }),
  UNIQUE: (args, state) => {
    if (args.length !== 1) return argCountError("UNIQUE", "1 argument (column name)", args.length);
    const col = collectColumnValues(args[0]!, state);
    if ("kind" in col) return col;
    // Count distinct NON-EMPTY values, case-sensitive. Empty strings
    // (blank cells) are not "a value" for unique-count purposes —
    // same convention as COUNT().
    const seen = new Set<string>();
    for (const v of col.values) {
      if (v.trim().length === 0) continue;
      seen.add(v);
    }
    return ok(seen.size);
  },
  STDEV: (args, state) =>
    aggregateColumn("STDEV", args, state, (nums) => {
      // Sample standard deviation (Bessel's correction, n-1 denominator).
      // Matches what most spreadsheet apps default to. Returns 0 for
      // n < 2 (no variance computable).
      if (nums.length < 2) return 0;
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (nums.length - 1);
      return Math.sqrt(variance);
    }),
  COUNTIF: (args, state) => {
    if (args.length !== 2) return argCountError("COUNTIF", "2 arguments (column, value)", args.length);
    const col = collectColumnValues(args[0]!, state);
    if ("kind" in col) return col;
    const valueArg = state.evaluate(args[1]!);
    if (valueArg.kind === "error") return valueArg;
    let count = 0;
    for (const v of col.values) if (isEqual(v, valueArg.value)) count++;
    return ok(count);
  },
  SUMIF: (args, state) => {
    if (args.length !== 3) return argCountError("SUMIF", "3 arguments (sumCol, condCol, condValue)", args.length);
    if (args[0]!.kind !== "col") {
      return err("TYPE_ERROR", `SUMIF: first argument must be a column name`);
    }
    if (args[1]!.kind !== "col") {
      return err("TYPE_ERROR", `SUMIF: second argument must be a column name`);
    }
    const sumLookup = lookupColumn(args[0]!.name, state.ctx);
    if (!("index" in sumLookup)) {
      return err(
        "UNKNOWN_COLUMN",
        `Unknown column "${args[0]!.name}"${sumLookup.suggestion ? ` — did you mean "${sumLookup.suggestion}"?` : ""}`,
        sumLookup.suggestion,
      );
    }
    const condLookup = lookupColumn(args[1]!.name, state.ctx);
    if (!("index" in condLookup)) {
      return err(
        "UNKNOWN_COLUMN",
        `Unknown column "${args[1]!.name}"${condLookup.suggestion ? ` — did you mean "${condLookup.suggestion}"?` : ""}`,
        condLookup.suggestion,
      );
    }
    const condValueArg = state.evaluate(args[2]!);
    if (condValueArg.kind === "error") return condValueArg;
    let total = 0;
    for (let r = 0; r < state.ctx.rows.length; r++) {
      if (isCurrentFormulaCell(r, condLookup.index, state.ctx) || isCurrentFormulaCell(r, sumLookup.index, state.ctx)) continue;
      const condResult = evaluateCell(r, condLookup.index, state.ctx);
      if (condResult.kind !== "ok") continue;
      if (!isEqual(condResult.value, condValueArg.value)) continue;
      const sumResult = evaluateCell(r, sumLookup.index, state.ctx);
      if (sumResult.kind !== "ok") continue;
      const n = toNumber(sumResult.value);
      if (n !== null) total += n;
    }
    return ok(total);
  },

  // --- PERCENT helper — sugar for ROUND(part / total * 100, 2) ---
  PERCENT: (args, state) => {
    if (args.length !== 2) return argCountError("PERCENT", "2 arguments (part, total)", args.length);
    const part = state.evaluate(args[0]!);
    if (part.kind === "error") return part;
    const total = state.evaluate(args[1]!);
    if (total.kind === "error") return total;
    const p = toNumber(part.value);
    const t = toNumber(total.value);
    if (p === null) return err("NON_NUMERIC", `PERCENT: "part" is not a number`);
    if (t === null) return err("NON_NUMERIC", `PERCENT: "total" is not a number`);
    if (t === 0) return err("DIV_BY_ZERO", `PERCENT: total is zero`);
    return ok(Math.round((p / t) * 10000) / 100);
  },
  PROGRESS: (args, state) => {
    if (args.length !== 1 && args.length !== 2) return argCountError("PROGRESS", "1 ratio or 2 arguments (done, total)", args.length);
    const doneResult = state.evaluate(args[0]!);
    if (doneResult.kind === "error") return doneResult;
    const done = toNumber(doneResult.value);
    if (done === null) return err("NON_NUMERIC", `PROGRESS: first argument is not a number`);

    if (args.length === 1) {
      return ok(createProgressValue(done, `${Math.round(clampProgress(done) * 100)}%`));
    }

    const totalResult = state.evaluate(args[1]!);
    if (totalResult.kind === "error") return totalResult;
    const total = toNumber(totalResult.value);
    if (total === null) return err("NON_NUMERIC", `PROGRESS: total is not a number`);
    if (total === 0) return err("DIV_BY_ZERO", `PROGRESS: total is zero`);
    return ok(createProgressValue(done / total, `${formatValue(done)}/${formatValue(total)}`));
  },

  // --- Row aggregates ---
  ROWSUM: (args, state) => {
    if (args.length !== 0) return argCountError("ROWSUM", "no arguments", args.length);
    const row = state.ctx.rows[state.ctx.currentRow] ?? [];
    let sum = 0;
    for (let i = 0; i < row.length; i++) {
      if (i === state.ctx.currentCol) continue;
      const result = evaluateCell(state.ctx.currentRow, i, state.ctx);
      if (result.kind !== "ok") continue;
      const n = toNumber(result.value);
      if (n !== null) sum += n;
    }
    return ok(sum);
  },
  ROWAVG: (args, state) => {
    if (args.length !== 0) return argCountError("ROWAVG", "no arguments", args.length);
    const row = state.ctx.rows[state.ctx.currentRow] ?? [];
    let sum = 0;
    let count = 0;
    for (let i = 0; i < row.length; i++) {
      if (i === state.ctx.currentCol) continue;
      const result = evaluateCell(state.ctx.currentRow, i, state.ctx);
      if (result.kind !== "ok") continue;
      const n = toNumber(result.value);
      if (n !== null) {
        sum += n;
        count++;
      }
    }
    return ok(count === 0 ? 0 : sum / count);
  },

  // --- Conditional ---
  IF: (args, state) => {
    if (args.length !== 3) return argCountError("IF", "3 arguments (condition, then, else)", args.length);
    const cond = state.evaluate(args[0]!);
    if (cond.kind === "error") return cond;
    return isTruthy(cond.value) ? state.evaluate(args[1]!) : state.evaluate(args[2]!);
  },
  IFEMPTY: (args, state) => {
    if (args.length !== 2) return argCountError("IFEMPTY", "2 arguments (value, fallback)", args.length);
    // For column refs we check the RAW cell text for emptiness so a
    // formula that legitimately returns an empty string isn't replaced
    // with the fallback. For other expressions, "empty" means empty
    // string after evaluation.
    if (args[0]!.kind === "col") {
      const lookup = lookupColumn(args[0]!.name, state.ctx);
      if (!("index" in lookup)) {
        return err(
          "UNKNOWN_COLUMN",
          `Unknown column "${args[0]!.name}"${lookup.suggestion ? ` — did you mean "${lookup.suggestion}"?` : ""}`,
          lookup.suggestion,
        );
      }
      const rawCell = cellAt(state.ctx.currentRow, lookup.index, state.ctx);
      if (rawCell.trim().length === 0) return state.evaluate(args[1]!);
      return evaluateCell(state.ctx.currentRow, lookup.index, state.ctx);
    }
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    if (typeof v.value === "string" && v.value.length === 0) return state.evaluate(args[1]!);
    return v;
  },
  IFERROR: (args, state) => {
    if (args.length !== 2) return argCountError("IFERROR", "2 arguments (formula, fallback)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return state.evaluate(args[1]!);
    return v;
  },

  // --- Logical combinators ---
  // Result is returned as numeric 1/0 to match the rest of the engine's
  // boolean handling (comparison operators do the same). Short-circuit
  // evaluation: AND stops on first false, OR stops on first true — so
  // expensive sub-expressions in later args are skipped when the
  // outcome is already decided.
  AND: (args, state) => {
    if (args.length === 0) return argCountError("AND", "at least 1 argument", args.length);
    for (const a of args) {
      const v = state.evaluate(a);
      if (v.kind === "error") return v;
      if (!isTruthy(v.value)) return ok(0);
    }
    return ok(1);
  },
  OR: (args, state) => {
    if (args.length === 0) return argCountError("OR", "at least 1 argument", args.length);
    for (const a of args) {
      const v = state.evaluate(a);
      if (v.kind === "error") return v;
      if (isTruthy(v.value)) return ok(1);
    }
    return ok(0);
  },
  NOT: (args, state) => {
    if (args.length !== 1) return argCountError("NOT", "1 argument", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    return ok(isTruthy(v.value) ? 0 : 1);
  },
  CONTAINS: (args, state) => {
    if (args.length !== 2) return argCountError("CONTAINS", "2 arguments (haystack, needle)", args.length);
    const h = state.evaluate(args[0]!);
    if (h.kind === "error") return h;
    const n = state.evaluate(args[1]!);
    if (n.kind === "error") return n;
    return ok(toString(h.value).includes(toString(n.value)) ? 1 : 0);
  },

  // --- String ---
  CONCAT: (args, state) => {
    let out = "";
    for (const a of args) {
      const v = state.evaluate(a);
      if (v.kind === "error") return v;
      out += toString(v.value);
    }
    return ok(out);
  },
  UPPER: (args, state) => {
    if (args.length !== 1) return argCountError("UPPER", "1 argument (text)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    return ok(toString(v.value).toUpperCase());
  },
  LOWER: (args, state) => {
    if (args.length !== 1) return argCountError("LOWER", "1 argument (text)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    return ok(toString(v.value).toLowerCase());
  },
  LEN: (args, state) => {
    if (args.length !== 1) return argCountError("LEN", "1 argument (text)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    return ok(toString(v.value).length);
  },
  SUBSTRING: (args, state) => {
    if (args.length !== 3) return argCountError("SUBSTRING", "3 arguments (text, start, length) — 0-indexed", args.length);
    const text = state.evaluate(args[0]!);
    if (text.kind === "error") return text;
    const start = state.evaluate(args[1]!);
    if (start.kind === "error") return start;
    const length = state.evaluate(args[2]!);
    if (length.kind === "error") return length;
    const s = toString(text.value);
    const startN = toNumber(start.value);
    const lenN = toNumber(length.value);
    if (startN === null) return err("NON_NUMERIC", `SUBSTRING: start is not a number`);
    if (lenN === null) return err("NON_NUMERIC", `SUBSTRING: length is not a number`);
    const startI = Math.max(0, Math.floor(startN));
    const endI = Math.max(startI, startI + Math.floor(lenN));
    return ok(s.slice(startI, endI));
  },
  TRIM: (args, state) => {
    if (args.length !== 1) return argCountError("TRIM", "1 argument (text)", args.length);
    const v = state.evaluate(args[0]!);
    if (v.kind === "error") return v;
    return ok(toString(v.value).trim());
  },
  LEFT: (args, state) => {
    if (args.length !== 2) return argCountError("LEFT", "2 arguments (text, n)", args.length);
    const text = state.evaluate(args[0]!);
    if (text.kind === "error") return text;
    const nArg = state.evaluate(args[1]!);
    if (nArg.kind === "error") return nArg;
    const n = toNumber(nArg.value);
    if (n === null) return err("NON_NUMERIC", `LEFT: n is not a number`);
    return ok(toString(text.value).slice(0, Math.max(0, Math.floor(n))));
  },
  RIGHT: (args, state) => {
    if (args.length !== 2) return argCountError("RIGHT", "2 arguments (text, n)", args.length);
    const text = state.evaluate(args[0]!);
    if (text.kind === "error") return text;
    const nArg = state.evaluate(args[1]!);
    if (nArg.kind === "error") return nArg;
    const n = toNumber(nArg.value);
    if (n === null) return err("NON_NUMERIC", `RIGHT: n is not a number`);
    const s = toString(text.value);
    const take = Math.max(0, Math.floor(n));
    return ok(take === 0 ? "" : s.slice(-take));
  },
  REPLACE: (args, state) => {
    if (args.length !== 3) return argCountError("REPLACE", "3 arguments (text, search, replacement)", args.length);
    const text = state.evaluate(args[0]!);
    if (text.kind === "error") return text;
    const search = state.evaluate(args[1]!);
    if (search.kind === "error") return search;
    const replacement = state.evaluate(args[2]!);
    if (replacement.kind === "error") return replacement;
    const searchStr = toString(search.value);
    if (searchStr.length === 0) {
      // `replaceAll` with empty needle inserts the replacement between
      // every character — almost never the user's intent and slow on
      // long strings. Reject explicitly.
      return err("PARSE_ERROR", `REPLACE: search string must be non-empty`);
    }
    return ok(toString(text.value).replaceAll(searchStr, toString(replacement.value)));
  },

  // --- Date / time helpers ---
  // Plain-ISO formatting — local timezone, no offset suffix. Same
  // convention as the `/now` `/date` slash commands so a doc-wide
  // search for a date string matches both sources.
  NOW: (args) => {
    if (args.length !== 0) return argCountError("NOW", "no arguments", args.length);
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return ok(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    );
  },
  TODAY: (args) => {
    if (args.length !== 0) return argCountError("TODAY", "no arguments", args.length);
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    return ok(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  },
  DATEDIFF: (args, state) => {
    if (args.length < 2 || args.length > 3) return argCountError("DATEDIFF", "2 or 3 arguments (d1, d2, unit?)", args.length);
    const d1V = state.evaluate(args[0]!);
    if (d1V.kind === "error") return d1V;
    const d2V = state.evaluate(args[1]!);
    if (d2V.kind === "error") return d2V;
    // ISO values follow the comparison operators, so a date without a
    // time is local midnight; other text keeps the Date parser's reading.
    const t1 = toDateTime(d1V.value) ?? new Date(toString(d1V.value)).getTime();
    const t2 = toDateTime(d2V.value) ?? new Date(toString(d2V.value)).getTime();
    if (Number.isNaN(t1)) return err("PARSE_ERROR", `DATEDIFF: first argument is not a valid date`);
    if (Number.isNaN(t2)) return err("PARSE_ERROR", `DATEDIFF: second argument is not a valid date`);
    let unit = "days";
    if (args.length === 3) {
      const u = state.evaluate(args[2]!);
      if (u.kind === "error") return u;
      unit = toString(u.value).toLowerCase();
    }
    // Two dates are whole days apart, also across a daylight saving change.
    const dayMs = 1000 * 60 * 60 * 24;
    const wholeDays = ISO_DATE.test(toString(d1V.value).trim()) && ISO_DATE.test(toString(d2V.value).trim());
    const diffMs = wholeDays ? Math.round((t2 - t1) / dayMs) * dayMs : t2 - t1;
    switch (unit) {
      case "ms":
      case "milliseconds":
        return ok(diffMs);
      case "s":
      case "seconds":
        return ok(diffMs / 1000);
      case "m":
      case "minutes":
        return ok(diffMs / (1000 * 60));
      case "h":
      case "hours":
        return ok(diffMs / (1000 * 60 * 60));
      case "d":
      case "days":
        return ok(diffMs / (1000 * 60 * 60 * 24));
      default:
        return err("PARSE_ERROR", `DATEDIFF: unknown unit "${unit}" — use one of ms / s / m / h / d (or full names)`);
    }
  },
};

// Function aliases — same impl, alternate name.
FUNCTIONS["MEAN"] = FUNCTIONS["AVG"]!;
FUNCTIONS["ROWMEAN"] = FUNCTIONS["ROWAVG"]!;

const FUNCTION_NAMES = Object.keys(FUNCTIONS);

// -- Binop application --------------------------------------------------------

/**
 * The two numbers the ordering operators compare, or null when the
 * values have no common order. Two dates compare as instants and never
 * with a number or other text, so `2026-10-12` is not `2026`. Text with
 * a unit, such as `5 €`, compares by its leading number, as does text
 * against text: `5 €` and `5.00 €` are neither smaller nor greater than
 * each other, even though `==` tells their texts apart.
 */
const orderedPair = (l: EvalValue, r: EvalValue): [number, number] | null => {
  const ld = toDateTime(l);
  const rd = toDateTime(r);
  if (ld !== null || rd !== null) return ld !== null && rd !== null ? [ld, rd] : null;
  const ln = toNumber(l);
  const rn = toNumber(r);
  return ln !== null && rn !== null ? [ln, rn] : null;
};

const applyBinop = (op: BinOp, l: EvalValue, r: EvalValue): EvalResult => {
  if (op === "==" || op === "!=") {
    const equal = isEqual(l, r);
    return ok((op === "==" ? equal : !equal) ? 1 : 0);
  }
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    const pair = orderedPair(l, r);
    if (pair === null) {
      return toDateTime(l) !== null || toDateTime(r) !== null
        ? err("TYPE_ERROR", `Cannot compare a date with a value that is not a date using "${op}"`)
        : err("NON_NUMERIC", `Cannot compare non-numeric values with "${op}"`);
    }
    const [a, b] = pair;
    if (op === "<") return ok(a < b ? 1 : 0);
    if (op === "<=") return ok(a <= b ? 1 : 0);
    if (op === ">") return ok(a > b ? 1 : 0);
    return ok(a >= b ? 1 : 0);
  }
  const ln = toNumber(l);
  const rn = toNumber(r);
  if (ln === null || rn === null) {
    return err("NON_NUMERIC", `Cannot compute non-numeric values with "${op}"`);
  }
  switch (op) {
    case "+":
      return ok(ln + rn);
    case "-":
      return ok(ln - rn);
    case "*":
      return ok(ln * rn);
    case "/":
      if (rn === 0) return err("DIV_BY_ZERO", `Division by zero`);
      return ok(ln / rn);
  }
};

// -- Visitor ------------------------------------------------------------------

const evaluateAst = (ast: AST, ctx: EvalContext): EvalResult => {
  const state: EvalState = {
    ctx,
    evaluate: (node) => evaluateAst(node, ctx),
  };

  switch (ast.kind) {
    case "num":
      return ok(ast.value);
    case "str":
      return ok(ast.value);
    case "col": {
      const lookup = lookupColumn(ast.name, ctx);
      if (!("index" in lookup)) {
        return err(
          "UNKNOWN_COLUMN",
          `Unknown column "${ast.name}"${lookup.suggestion ? ` — did you mean "${lookup.suggestion}"?` : ""}`,
          lookup.suggestion,
        );
      }
      return evaluateCell(ctx.currentRow, lookup.index, ctx);
    }
    case "neg": {
      const v = evaluateAst(ast.operand, ctx);
      if (v.kind === "error") return v;
      const n = toNumber(v.value);
      if (n === null) return err("NON_NUMERIC", `Cannot negate non-numeric value`);
      return ok(-n);
    }
    case "binop": {
      const l = evaluateAst(ast.left, ctx);
      if (l.kind === "error") return l;
      const r = evaluateAst(ast.right, ctx);
      if (r.kind === "error") return r;
      return applyBinop(ast.op, l.value, r.value);
    }
    case "call": {
      const fn = FUNCTIONS[ast.name.toUpperCase()];
      if (!fn) {
        const suggestion = findClosest(ast.name.toUpperCase(), FUNCTION_NAMES);
        return err("UNKNOWN_FUNCTION", `Unknown function "${ast.name}"${suggestion ? ` — did you mean "${suggestion}"?` : ""}`, suggestion);
      }
      return fn(ast.args, state);
    }
  }
};

// =============================================================================
// Public API
// =============================================================================

/**
 * Evaluate a formula string against a table context.
 *
 * The leading `=` is required (it's the marker that distinguishes a
 * formula from a literal cell value). Whitespace is ignored.
 */
export const evaluateFormula = (source: string, ctx: EvalContext): EvalResult => {
  if (!source.startsWith("=")) {
    return err("PARSE_ERROR", `Formula must start with "="`);
  }
  const body = source.slice(1).trim();
  if (body.length === 0) {
    return err("PARSE_ERROR", `Empty formula`);
  }
  const tokens = tokenize(body);
  if (!Array.isArray(tokens)) return tokens;
  const ast = new Parser(tokens).parse();
  if ("kind" in ast && ast.kind === "error") return ast;
  return evaluateAst(ast as AST, ctx);
};

/** Format an `EvalResult` value for display in a cell. */
export const formatValue = (value: EvalValue): string => {
  const progress = parseProgressValue(value);
  if (progress) return progress.label;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return value;
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "∞" : "-∞";
  // Strip trailing zeros from decimal display but keep up to 6 places.
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
};

/** Whether a cell value is a formula (starts with `=`, no extra space). */
export const isFormula = (cell: string): boolean => cell.startsWith("=");

/** Aggregate-function names — used by the total-row heuristic. */
const AGGREGATE_FNS = ["SUM", "AVG", "MEAN", "MIN", "MAX", "COUNT", "MEDIAN", "ROWSUM", "ROWAVG", "ROWMEAN"];

/**
 * Heuristic: a row is a "total" / summary row when at least half of
 * its FORMULA cells use aggregate functions (`SUM`, `AVG`, `MEDIAN`,
 * etc.). Non-formula cells (literal text, empty cells) are ignored
 * entirely — only the formulas in the row factor into the ratio. So
 * a row like `["Total", "", "", "=SUM(price)"]` is true (1 / 1
 * formula cell is an aggregate) and a row of mostly hand-typed
 * numbers stays false even if it has one computed cell.
 *
 * Renderers tag matching `<tr>` with `md-table-total-row` for the
 * subtle bg + bold styling.
 */
export const isTotalRow = (rowTexts: string[]): boolean => {
  let formulaCells = 0;
  let aggregateCells = 0;
  for (const text of rowTexts) {
    if (!isFormula(text)) continue;
    formulaCells++;
    const stripped = text.slice(1).trim().toUpperCase();
    for (const fn of AGGREGATE_FNS) {
      if (stripped === fn || stripped === `${fn}()` || stripped.startsWith(`${fn}(`)) {
        aggregateCells++;
        break;
      }
    }
  }
  return formulaCells > 0 && aggregateCells / formulaCells >= 0.5;
};
