import { expect, test } from "bun:test";
import { collectFieldRefs, FORMULA_LIMITS, parseFormula } from "./parser";

test("bounds nested and left-associative expressions before recursive consumers run", () => {
  for (const source of [
    "(".repeat(FORMULA_LIMITS.depth) + "1" + ")".repeat(FORMULA_LIMITS.depth),
    "-".repeat(FORMULA_LIMITS.depth) + "1",
    Array(FORMULA_LIMITS.depth + 1)
      .fill("1")
      .join("+"),
  ]) {
    expect(parseFormula(source)).toMatchObject({ ok: false, error: `Formula exceeds ${FORMULA_LIMITS.depth} levels of nesting` });
  }
  expect(parseFormula(Array(FORMULA_LIMITS.depth).fill("1").join("+")).ok).toBe(true);
});

test("bounds source size and wide expressions with actionable diagnostics", () => {
  expect(parseFormula("1".repeat(FORMULA_LIMITS.sourceLength + 1))).toMatchObject({
    ok: false,
    error: `Formula exceeds ${FORMULA_LIMITS.sourceLength} characters`,
  });
  expect(parseFormula(`CONCAT(${Array(FORMULA_LIMITS.nodes).fill("'a'").join(",")})`)).toMatchObject({
    ok: false,
    error: `Formula exceeds ${FORMULA_LIMITS.nodes} expression nodes`,
  });
  expect(
    parseFormula(
      `CONCAT(${Array(FORMULA_LIMITS.nodes - 1)
        .fill("'a'")
        .join(",")})`,
    ).ok,
  ).toBe(true);
});

test("parses literal", () => {
  const r = parseFormula("42");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.ast).toEqual({ kind: "literal", value: 42 });
});

test("parses string literal", () => {
  const r = parseFormula("'hello'");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.ast).toEqual({ kind: "literal", value: "hello" });
});

test("parses context references only when explicitly enabled", () => {
  expect(parseFormula("@auth.id").ok).toBe(false);

  const result = parseFormula("@params.record_id = @auth.id", { contextRefs: true });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.ast).toEqual({
    kind: "binop",
    op: "=",
    left: { kind: "call", fn: "@", args: [{ kind: "literal", value: "params.record_id" }] },
    right: { kind: "call", fn: "@", args: [{ kind: "literal", value: "auth.id" }] },
  });
});

test("rejects malformed context references", () => {
  const missingName = parseFormula("@auth", { contextRefs: true });
  expect(missingName).toMatchObject({ ok: false, error: "context reference needs a namespace and name" });

  const emptyPart = parseFormula("@params.", { contextRefs: true });
  expect(emptyPart).toMatchObject({ ok: false, error: "invalid context reference" });
});

test("parses quoted field name references", () => {
  const r = parseFormula('"Unit price" * Quantity');
  expect(r.ok).toBe(true);
  if (r.ok && r.ast.kind === "binop") {
    expect(r.ast.left).toEqual({ kind: "field", fieldId: "Unit price" });
    expect(r.ast.right).toEqual({ kind: "field", fieldId: "Quantity" });
  }
});

test("parses field reference", () => {
  const r = parseFormula("{FLDX01}");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.ast).toEqual({ kind: "field", fieldId: "FLDX01" });
});

test("scoped field references are opt-in for GQL expressions", () => {
  expect(parseFormula("customer.name").ok).toBe(false);

  const bare = parseFormula("customer.name", { scopedRefs: true });
  expect(bare.ok).toBe(true);
  if (bare.ok) expect(bare.ast).toEqual({ kind: "field", fieldId: "customer.name" });

  const quoted = parseFormula('customer."Full name"', { scopedRefs: true });
  expect(quoted.ok).toBe(true);
  if (quoted.ok) expect(quoted.ast).toEqual({ kind: "field", fieldId: 'customer."Full name"' });

  const braced = parseFormula("customer.{FLDX01}", { scopedRefs: true });
  expect(braced.ok).toBe(true);
  if (braced.ok) expect(braced.ast).toEqual({ kind: "field", fieldId: "customer.{FLDX01}" });
});

test("operator precedence: * binds tighter than +", () => {
  const r = parseFormula("1 + 2 * 3");
  expect(r.ok).toBe(true);
  if (r.ok && r.ast.kind === "binop") {
    expect(r.ast.op).toBe("+");
    expect(r.ast.right.kind).toBe("binop");
    if (r.ast.right.kind === "binop") expect(r.ast.right.op).toBe("*");
  }
});

test("parens override precedence", () => {
  const r = parseFormula("(1 + 2) * 3");
  expect(r.ok).toBe(true);
  if (r.ok && r.ast.kind === "binop") {
    expect(r.ast.op).toBe("*");
    expect(r.ast.left.kind).toBe("binop");
  }
});

test("parses function call", () => {
  const r = parseFormula("CONCAT('foo', ' ', {FLDY01})");
  expect(r.ok).toBe(true);
  if (r.ok && r.ast.kind === "call") {
    expect(r.ast.fn).toBe("CONCAT");
    expect(r.ast.args).toHaveLength(3);
  }
});

test("accepts optional leading equals for spreadsheet-style authoring", () => {
  const r = parseFormula("=SUM({PRICE1}, 2)");
  expect(r.ok).toBe(true);
  if (r.ok && r.ast.kind === "call") {
    expect(r.ast.fn).toBe("SUM");
    expect(r.ast.args[0]).toEqual({ kind: "field", fieldId: "PRICE1" });
  }
});

test("parses unary minus", () => {
  const r = parseFormula("-{FLDX01}");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.ast.kind).toBe("unop");
});

test("rejects unclosed paren", () => {
  expect(parseFormula("(1 + 2").ok).toBe(false);
});

test("rejects unclosed string", () => {
  expect(parseFormula('"hello').ok).toBe(false);
});

test("rejects unclosed field reference", () => {
  expect(parseFormula("{fld_x").ok).toBe(false);
});

test("parses bare identifiers as field name references", () => {
  const r = parseFormula("foo");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.ast).toEqual({ kind: "field", fieldId: "foo" });
});

test("rejects trailing tokens", () => {
  expect(parseFormula("1 + 2 3").ok).toBe(false);
});

test("reports the offending token inside nested formulas", () => {
  const result = parseFormula("IF(true, SUM(1, ), 0)");

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.diagnostic).toEqual({
      message: "unexpected token rparen",
      span: { start: 16, end: 17 },
    });
  }
});

test("keeps diagnostic spans relative to the original spreadsheet-style source", () => {
  const result = parseFormula("  =  IF(true, SUM(1, ), 0)");

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.span).toEqual({ start: 21, end: 22 });
});

test("reports the complete unterminated reference span", () => {
  const result = parseFormula("{missing");

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.diagnostic.span).toEqual({ start: 0, end: 8 });
});

test("collectFieldRefs walks nested expression", () => {
  const r = parseFormula("IF({FLDA01} > 0, {FLDB01} * 2, {FLDC01})");
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect([...collectFieldRefs(r.ast)].sort()).toEqual(["FLDA01", "FLDB01", "FLDC01"]);
  }
});

test("rejects removed hash references", () => {
  expect(parseFormula("#abc12").ok).toBe(false);
  expect(parseFormula("#abc_12*2").ok).toBe(false);
  expect(parseFormula("#").ok).toBe(false);
  expect(parseFormula("# + 1").ok).toBe(false);
});

test("rejects invalid braced field references", () => {
  expect(parseFormula("{ }").ok).toBe(false);
  expect(parseFormula("{field with spaces}").ok).toBe(false);
  expect(parseFormula(`{${"x".repeat(81)}}`).ok).toBe(false);
});

// ── Whitespace insensitivity ─────────────────────────────────────
//
// Regression guard for spacing around public refs — all variants
// must tokenise identically. We compare ASTs to lock down the
// tokeniser's whitespace-skipping behaviour around every operator
// position (after the slug, before & after the binary op).

test.each(["{FIELD1}*1.19", "{FIELD1} *1.19", "{FIELD1}* 1.19", "{FIELD1} * 1.19", "\t{FIELD1}\n*\r1.19"])(
  "whitespace-variant '%s' produces the same AST",
  (src) => {
    const r = parseFormula(src);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ast).toEqual({
        kind: "binop",
        op: "*",
        left: { kind: "field", fieldId: "FIELD1" },
        right: { kind: "literal", value: 1.19 },
      });
    }
  },
);
