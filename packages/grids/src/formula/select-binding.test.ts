import { expect, test } from "bun:test";
import { evaluate } from "./evaluator";
import { parseFormula } from "./parser";
import { bindFormulaSelects, type FormulaSelect } from "./select-binding";
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
