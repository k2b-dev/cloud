import { expect, test } from "bun:test";
import { evaluate } from "./evaluator";
import { parseFormula } from "./parser";
import { bindFormulaSelects, canonicalizeFormulaOptions, type FormulaSelect, resolveFormulaOption } from "./select-binding";
import { isFormulaError } from "./types";

const select: FormulaSelect = {
  name: "Tax",
  config: {
    options: [
      { id: "ust-19", label: "19 %" },
      { id: "ust-1", label: "1 %" },
    ],
  },
};
const run = (source: string, value: unknown, multiple = false) => {
  const parsed = parseFormula(source);
  if (!parsed.ok) throw Error(parsed.error);
  return evaluate(parsed.ast, { fields: { Tax: value }, selectFields: { Tax: { ...select, config: { ...select.config, multiple } } } });
};

test("single Select equality resolves exact IDs and unambiguous labels", () => {
  expect(run("Tax = 'ust-19'", ["ust-19"])).toBe(true);
  expect(run("'19 %' = Tax", ["ust-19"])).toBe(true);
  expect(run("Tax != 'ust-19'", ["ust-19"])).toBe(false);
  expect(run("Tax = 'ust-1'", ["ust-19"])).toBe(false);
  expect(run("Tax = null", [])).toBe(true);
  expect(run("ISBLANK(Tax)", null)).toBe(true);
  expect(run("Tax != null", ["ust-19"])).toBe(true);
});

test("Select membership is exact; multi-select equality and text coercion are diagnosed", () => {
  expect(run("HAS_OPTION(Tax, 'ust-1')", ["ust-19"], true)).toBe(false);
  expect(run("HAS_OPTION(Tax, '19 %')", ["ust-19"], true)).toBe(true);
  expect(run("HAS_OPTION(Tax, '19 %')", [], true)).toBe(false);
  for (const source of ["Tax = '19 %'", "CONTAINS(Tax, 'ust-1')", "Tax + 1", "HAS_OPTION(Tax, 'missing')"])
    expect(isFormulaError(run(source, ["ust-19"], true))).toBe(true);
});

test("unknown and ambiguous Select labels fail without sample data", () => {
  const ast = parseFormula("Tax = 'duplicate'");
  if (!ast.ok) throw Error(ast.error);
  expect(bindFormulaSelects(ast.ast, () => select).ok).toBe(false);
  expect(
    bindFormulaSelects(ast.ast, () => ({
      name: "Tax",
      config: {
        options: [
          { id: "a", label: "duplicate" },
          { id: "b", label: "duplicate" },
        ],
      },
    })),
  ).toMatchObject({ ok: false, error: expect.stringContaining("Ambiguous") });
});

test("authoring persists option IDs without rewriting other literals or formatting", () => {
  const source = "= IF(Tax = ('19 %'), '19 %', IF(HAS_OPTION(Tax, '1 %'), 1, 0))";
  const result = canonicalizeFormulaOptions(source, () => select);
  expect(result).toEqual({ ok: true, source: "= IF(Tax = 'ust-19', '19 %', IF(HAS_OPTION(Tax, 'ust-1'), 1, 0))" });
  if (!result.ok) return;
  const renamed = {
    ...select,
    config: {
      options: [
        { id: "ust-19", label: "Standard" },
        { id: "ust-1", label: "Reduced" },
      ],
    },
  };
  expect(canonicalizeFormulaOptions(result.source, () => renamed)).toEqual(result);
  expect(canonicalizeFormulaOptions(result.source, () => ({ ...renamed, config: { options: [] } })).ok).toBe(false);
});

test("empty strings do not select an option with an empty label", () => {
  expect(resolveFormulaOption({ name: "Tax", config: { options: [{ id: "empty", label: "" }] } }, "").ok).toBe(false);
  expect(resolveFormulaOption({ name: "Tax", config: {} }, "anything").ok).toBe(false);
});

test("runtime errors contain a stable code, not a field name or sentence", () => {
  expect(run("Tax = 'missing'", [])).toMatchObject({ code: "SELECT_INVALID" });
});

test("collection values are not silently coerced by scalar functions", () => {
  for (const source of ["CONTAINS(Lookup, 'ust')", "LEN(Lookup)", "Lookup = 'ust-19'"]) {
    const parsed = parseFormula(source);
    if (!parsed.ok) throw Error(parsed.error);
    expect(evaluate(parsed.ast, { fields: { Lookup: ["ust-19"] } })).toMatchObject({ code: "NON_SCALAR" });
  }
  expect(canonicalizeFormulaOptions("Tax = 'missing'", () => select, "de")).toMatchObject({
    ok: false,
    error: expect.stringContaining("Unbekannte Option"),
  });
});
