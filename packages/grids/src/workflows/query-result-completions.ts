import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { workflowCompletionContext } from "@k2b/cloud/workflows";
import { isWorkflowReservedReferenceRoot, parseWorkflowYaml } from "@k2b/cloud/workflows/language";
import { gridsWorkflowManifest } from "./manifest";

const object = (value: WorkflowJsonValue | undefined): Record<string, WorkflowJsonValue> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

/** Suggestions only: the normal compiler/binder remains authoritative for validity. */
export function queryResultCompletions(source: string, caret: number): string[] {
  const context = workflowCompletionContext(source, caret);
  if (context.key !== "data") return [];
  // A partial scalar (including an unfinished quote) must not prevent parsing.
  const edited = `${source.slice(0, context.range.start)}__query_result_completion__${source.slice(context.range.end)}`;
  const parsed = parseWorkflowYaml(edited);
  if (!parsed.ok) return [];
  const root = object(parsed.parsed.value);
  if (!root) return [];
  // Inputs live under inputs.<name>, not in the action-result namespace.
  const initial = new Map<string, boolean>();
  const defineName = (scope: Map<string, boolean>, name: WorkflowJsonValue | undefined, query: boolean) => {
    if (typeof name !== "string") return;
    scope.set(name, !scope.has(name) && !isWorkflowReservedReferenceRoot(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && query);
  };
  const visit = (
    value: WorkflowJsonValue | undefined,
    path: Array<string | number>,
    inherited: Map<string, boolean>,
    depth = 0,
  ): string[] | undefined => {
    if (!Array.isArray(value)) return;
    const maxDepth = gridsWorkflowManifest.limits?.maxDepth;
    if (maxDepth !== undefined && depth > maxDepth) return;
    const scope = new Map(inherited);
    for (const [index, raw] of value.entries()) {
      const step = object(raw);
      if (!step) continue;
      const stepPath = [...path, index];
      const dataLocation = parsed.parsed.sourceLocations[[...stepPath, "generateDocument", "data"].join(".")];
      if (
        dataLocation &&
        dataLocation.offset >= context.caret - context.line.length &&
        dataLocation.offset < context.range.start &&
        object(step.generateDocument)?.data === "__query_result_completion__"
      ) {
        return [...scope].filter(([, query]) => query).map(([name]) => name);
      }
      const branches: Array<{ value: WorkflowJsonValue | undefined; path: Array<string | number>; scope: Map<string, boolean> }> = [];
      if (Object.hasOwn(step, "if")) {
        for (const branch of ["then", "else"]) branches.push({ value: step[branch], path: [...stepPath, branch], scope });
      } else if (Object.hasOwn(step, "switch")) {
        if (Array.isArray(step.cases))
          step.cases.forEach((item, caseIndex) =>
            branches.push({ value: object(item)?.do, path: [...stepPath, "cases", caseIndex, "do"], scope }),
          );
        branches.push({ value: step.default, path: [...stepPath, "default"], scope });
      } else if (Object.hasOwn(step, "forEach")) {
        const loop = new Map(scope);
        defineName(loop, step.as, false);
        branches.push({ value: step.do, path: [...stepPath, "do"], scope: loop });
      } else if (Object.keys(step).length === 1) {
        const [action, config] = Object.entries(step)[0]!;
        const options = object(config);
        defineName(scope, action === "setVariable" ? options?.name : options?.saveAs, action === "query" || action === "parseDocument");
      }
      for (const branch of branches) {
        const found = visit(branch.value, branch.path, branch.scope, depth + 1);
        if (found) return found;
      }
    }
  };
  return visit(root.steps, ["steps"], initial) ?? [];
}
