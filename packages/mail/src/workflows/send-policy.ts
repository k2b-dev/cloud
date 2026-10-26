import {
  AI_WORKFLOW_ACTIONS,
  type WorkflowCondition,
  type WorkflowIrInput,
  type WorkflowIrStep,
  type WorkflowJsonValue,
} from "@k2b/cloud/workflows";
import { parseWorkflowValueString } from "@k2b/cloud/workflows/language";
import { Liquid, type Template, toValueSync } from "liquidjs";
import { MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS } from "./template-validation";

const aiActions = new Set(Object.keys(AI_WORKFLOW_ACTIONS));
// Include local references: a definition in an untaken Liquid branch must not
// hide a read of the real invocation value from a send authorization check.
const templates = new Liquid();

type TemplatePath = ReturnType<Liquid["variableSegmentsSync"]>[number];
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Liquid's variable analysis flattens a computed root ([key]) into the key's
// own path, and *_exp filters (where_exp, group_by_exp, …) evaluate a string
// argument against the whole context. Inspect expression nodes and refuse both.
const hasDynamicRead = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasDynamicRead);
  if (!isObject(value)) return false;
  if (typeof value.name === "string" && value.name.endsWith("_exp")) return true;
  if (Array.isArray(value.props)) {
    const root = value.props[0];
    if (value.variable !== undefined || (isObject(root) && Array.isArray(root.props))) return true;
  }
  // Follow expression nodes, including bracket property expressions, never the
  // parser/engine back references.
  return ["initial", "postfix", "filters", "args", "lhs", "rhs", "props"].some((key) => hasDynamicRead(value[key]));
};
const containsDynamicRead = (nodes: readonly Template[]): boolean =>
  nodes.some(
    (node) =>
      (node.arguments && [...node.arguments()].some(hasDynamicRead)) ||
      (node.children && containsDynamicRead(toValueSync(node.children(false, true)))),
  );

export const MAIL_WORKFLOW_SEND_REVIEW_MESSAGE =
  "Workflows that may use AI or conversation summary values must create a draft for a person to review and send.";

/**
 * Check the whole definition, including branches this run did not take. A summary
 * may have been written by another AI workflow, so copying it (or its containing
 * conversation object) also requires review. Conversation action targets are refs,
 * not content reads.
 */
export const mailWorkflowNeedsSendReview = (steps: readonly WorkflowIrStep[], inputs: readonly WorkflowIrInput[]): boolean => {
  const conversations = inputs.filter((input) => input.type === "mailConversation").map((input) => `inputs.${input.name}`);
  const summaryPaths = [...conversations.map((root) => [...root.split("."), "summary"]), ["context", "source", "conversation", "summary"]];
  // Ancestors copy a summary-bearing object; computed segments may select any
  // property. A known different field, such as conversation.subject, is safe.
  const pathReadsSummary = (path: TemplatePath): boolean =>
    summaryPaths.some((summary) =>
      path
        .slice(0, Math.min(path.length, summary.length))
        .every((segment, index) => Array.isArray(segment) || String(segment) === summary[index]),
    );
  const readsSummary = (reference: string): boolean => pathReadsSummary(reference.split("."));
  const inspect = (value: WorkflowJsonValue): boolean => {
    if (Array.isArray(value)) return value.some(inspect);
    if (value !== null && typeof value === "object") return Object.values(value).some(inspect);
    if (typeof value !== "string") return false;
    const parsed = parseWorkflowValueString(value);
    if (parsed.kind === "invalid") return true;
    if (parsed.kind === "expression") return parsed.expression.kind === "reference" && readsSummary(parsed.expression.reference);
    return false;
  };
  const conditionReadsSummary = (condition: WorkflowCondition): boolean => {
    if (condition.operator === "exists") return readsSummary(condition.reference);
    if (condition.operator === "all" || condition.operator === "any") return condition.conditions.some(conditionReadsSummary);
    if (condition.operator === "not") return conditionReadsSummary(condition.condition);
    return condition.operands.some(inspect);
  };
  const visit = (nodes: readonly WorkflowIrStep[]): boolean =>
    nodes.some((step) => {
      if (step.kind === "action") {
        return (
          aiActions.has(step.action) ||
          Object.entries(step.config).some(([field, value]) => {
            if (field === "conversation") return false;
            if (typeof value === "string" && MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS[step.action]?.includes(field)) {
              try {
                const parsed = templates.parse(value);
                return containsDynamicRead(parsed) || templates.variableSegmentsSync(parsed, { partials: false }).some(pathReadsSummary);
              } catch {
                return true;
              }
            }
            return inspect(value);
          })
        );
      }
      if (step.kind === "if") return conditionReadsSummary(step.condition) || visit(step.then) || visit(step.else);
      if (step.kind === "switch")
        return inspect(step.value) || visit(step.default) || step.cases.some((branch) => inspect(branch.when) || visit(branch.steps));
      return readsSummary(step.reference) || visit(step.steps);
    });
  return visit(steps);
};
