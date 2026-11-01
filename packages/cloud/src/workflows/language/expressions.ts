// Callers trim the captured text; no `\s*` around the group keeps matching linear.
const EXACT_EXPRESSION = /^\$\{\{([^{}]+)\}\}$/;
const EMBEDDED_EXPRESSION = /\$\{\{([^{}]+)\}\}/g;
const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[^{}]+)?$/;

export type WorkflowValueExpression = { kind: "now" } | { kind: "reference"; reference: string };

export type WorkflowValueString = { kind: "literal" } | { kind: "invalid" } | { kind: "expression"; expression: WorkflowValueExpression };

const parseExpression = (source: string): WorkflowValueExpression | null => {
  const expression = source.trim();
  if (expression === "now()") return { kind: "now" };
  return REFERENCE.test(expression) ? { kind: "reference", reference: expression } : null;
};

export const parseWorkflowValueString = (value: string): WorkflowValueString => {
  const match = EXACT_EXPRESSION.exec(value);
  if (!match) return value.includes("${{") ? { kind: "invalid" } : { kind: "literal" };
  const expression = parseExpression(match[1] ?? "");
  return expression ? { kind: "expression", expression } : { kind: "invalid" };
};

export const workflowValueExpression = (reference: string): string => `\${{ ${reference} }}`;

export const workflowMessageExpressions = (
  message: string,
): Array<{ source: string; raw: string; index: number; expression: WorkflowValueExpression | null }> =>
  [...message.matchAll(EMBEDDED_EXPRESSION)].map((match) => ({
    source: match[1]?.trim() ?? "",
    raw: match[0],
    index: match.index ?? 0,
    expression: parseExpression(match[1] ?? ""),
  }));

export const hasInvalidWorkflowMessageExpression = (message: string): boolean => message.replace(EMBEDDED_EXPRESSION, "").includes("${{");
