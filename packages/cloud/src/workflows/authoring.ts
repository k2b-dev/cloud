import type { DefinedWorkflowModule } from "./module";

export type WorkflowCompletionKind = "keyword" | "source" | "field" | "literal";

export type WorkflowCompletionItem = {
  label: string;
  kind: WorkflowCompletionKind;
  detail?: string;
  insertText: string;
  textEdit: { start: number; end: number; text: string };
  commitCharacters?: string[];
};

export type WorkflowCompletionContext = {
  caret: number;
  line: string;
  key: string | undefined;
  range: { start: number; end: number };
};

export const workflowCompletionContext = (source: string, caret: number): WorkflowCompletionContext => {
  const clampedCaret = Math.min(Math.max(caret, 0), source.length);
  const lineStart = source.lastIndexOf("\n", Math.max(0, clampedCaret - 1)) + 1;
  const lineEnd = source.indexOf("\n", clampedCaret);
  const end = lineEnd === -1 ? source.length : lineEnd;
  const line = source.slice(lineStart, clampedCaret);
  const colon = line.indexOf(":");
  const range =
    colon >= 0
      ? {
          start: lineStart + colon + 1 + (line.slice(colon + 1).match(/^\s*/)?.[0].length ?? 0),
          end,
        }
      : {
          start: clampedCaret - (/[A-Za-z0-9_-]*$/.exec(line)?.[0].length ?? 0),
          end: clampedCaret,
        };
  return {
    caret: clampedCaret,
    line,
    key: /^\s*(?:-\s*)?([A-Za-z][A-Za-z0-9]*)\s*:/.exec(line)?.[1],
    range,
  };
};

export const workflowCompletionItem = (
  context: Pick<WorkflowCompletionContext, "range">,
  kind: WorkflowCompletionKind,
  label: string,
  insertText: string,
  detail?: string,
): WorkflowCompletionItem => ({
  label,
  kind,
  insertText,
  textEdit: { ...context.range, text: insertText },
  ...(detail ? { detail } : {}),
});

export const buildWorkflowManifestCompletions = (
  source: string,
  caret: number,
  workflows: DefinedWorkflowModule,
): WorkflowCompletionItem[] => {
  const manifest = workflows.manifest;
  const context = workflowCompletionContext(source, caret);
  const indentation = context.line.match(/^\s*/)?.[0].length ?? 0;
  const preceding = source
    .slice(0, context.caret - context.line.length)
    .trimEnd()
    .split("\n");
  const parent = preceding.findLast((line) => line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) < indentation);
  const inlineCondition = /^\s*(?:-\s*)?(?:if|not):\s*[A-Za-z]*$/.test(context.line);
  const parentCondition = /^(\s*(?:-\s*)?)(?:if|all|any|not):\s*$/.exec(parent ?? "");
  const blockCondition =
    !context.key && /^\s*(?:-\s*)?[A-Za-z]*$/.test(context.line) && parentCondition && indentation > parentCondition[1]!.length;
  if (inlineCondition || blockCondition) {
    return [
      "equals",
      "notEquals",
      "includes",
      "textEquals",
      "contains",
      "startsWith",
      "endsWith",
      "greaterThan",
      "lessThan",
      "atLeast",
      "atMost",
      "exists",
      "all",
      "any",
      "not",
    ].map((operator) =>
      workflowCompletionItem(context, "keyword", operator, inlineCondition ? `{ ${operator}: [] }` : `${operator}: `, "Workflow condition"),
    );
  }
  if (context.key === "type") {
    return manifest.inputs.map((input) => workflowCompletionItem(context, "literal", input.kind, input.kind, input.description));
  }
  if (/^\s*-\s*[A-Za-z0-9_]*$/.test(context.line)) {
    return manifest.actions.map((action) =>
      workflowCompletionItem(context, "keyword", action.kind, `${action.kind}:\n    `, action.description),
    );
  }
  const lineStart = context.caret - context.line.length;
  const prefix = source.slice(0, lineStart);
  const triggerBlock = source.slice(prefix.lastIndexOf("triggers:"), lineStart).replace("triggers:", "");
  if (/^triggers:\s*$/m.test(prefix) && !/^\S/m.test(triggerBlock)) {
    return manifest.triggers.map((trigger) =>
      workflowCompletionItem(context, "keyword", trigger.kind, trigger.snippet ?? `${trigger.kind}:\n  `, trigger.description),
    );
  }
  return [
    workflowCompletionItem(context, "keyword", "inputs", "inputs:\n  ", "Declare typed inputs"),
    workflowCompletionItem(context, "keyword", "triggers", "triggers:\n  ", "Declare automatic triggers"),
    workflowCompletionItem(context, "keyword", "steps", "steps:\n  - ", "Declare workflow steps"),
  ];
};
