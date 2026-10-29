import { describe, expect, test } from "bun:test";
import {
  hasInvalidWorkflowMessageExpression,
  parseWorkflowValueString,
  workflowMessageExpressions,
  workflowValueExpression,
} from "./expressions";

describe("workflow expressions", () => {
  test("distinguishes explicit expressions from literals", () => {
    expect(parseWorkflowValueString("inputs.item.Name")).toEqual({ kind: "literal" });
    expect(parseWorkflowValueString("${{ inputs.item.Name }}")).toEqual({
      kind: "expression",
      expression: { kind: "reference", reference: "inputs.item.Name" },
    });
    expect(parseWorkflowValueString("${{ now() }}")).toEqual({ kind: "expression", expression: { kind: "now" } });
    expect(workflowValueExpression("inputs.item.Name")).toBe("${{ inputs.item.Name }}");
  });

  test("parses long whitespace runs in linear time", () => {
    const padding = "\t".repeat(200_000);
    expect(parseWorkflowValueString(`\${{{{${padding}`)).toEqual({ kind: "invalid" });
    expect(parseWorkflowValueString(`\${{${padding}inputs.item.Name${padding}}}`)).toEqual({
      kind: "expression",
      expression: { kind: "reference", reference: "inputs.item.Name" },
    });
    expect(workflowMessageExpressions(`\${{z${padding}`)).toEqual([]);
  });

  test("reports malformed and embedded expressions", () => {
    expect(parseWorkflowValueString("before ${{ inputs.item }}")).toEqual({ kind: "invalid" });
    expect(workflowMessageExpressions("Returned ${{ inputs.item.Name }} at ${{ now() }}")).toHaveLength(2);
    expect(hasInvalidWorkflowMessageExpression("Returned ${{ inputs.item.Name }}")).toBe(false);
    expect(hasInvalidWorkflowMessageExpression("Returned ${{ inputs.item.Name }")).toBe(true);
  });
});
