import { type Highlighter, highlight } from "@k2b/stdlib";
import type { Completion, SuggestContext, Suggestion } from "@k2b/ui";
import type { WorkflowCompletionItem, WorkflowFieldSchema } from "./index";
import type { DefinedWorkflowModule } from "./module";

export type WorkflowAutocompleteRequest = {
  source: string;
  caret: number;
};

export type WorkflowAutocompleteResponse<TDiagnostics = unknown> = {
  items: WorkflowCompletionItem[];
  diagnostics?: TDiagnostics;
};

type WorkflowAutocompleteFetcher<TResponse extends WorkflowAutocompleteResponse> = (
  request: WorkflowAutocompleteRequest,
  signal: AbortSignal,
) => Promise<TResponse>;

const WORKFLOW_TRIGGER_CHARS = [" ", "\n", "\t", ":", "-", ".", "[", "{", ",", "'"];
export const workflowCompletionItemToSuggestion = (item: WorkflowCompletionItem): Suggestion => ({
  text: item.insertText,
  label: item.label,
  hint: item.detail ?? item.kind,
  appendSpace: false,
  textEdit: item.textEdit,
});

export const buildWorkflowAutocompleteCompletions = <TResponse extends WorkflowAutocompleteResponse>(config: {
  fetchAutocomplete: WorkflowAutocompleteFetcher<TResponse>;
  onResponse?: (response: TResponse) => void;
}): Completion[] => {
  const suggest = (_query: string, ctx: SuggestContext, signal: AbortSignal): Suggestion[] | Promise<Suggestion[]> => {
    if (signal.aborted) return [];
    return config.fetchAutocomplete({ source: ctx.fullText, caret: ctx.caret }, signal).then((response) => {
      if (signal.aborted) return [];
      config.onResponse?.(response);
      return response.items.map(workflowCompletionItemToSuggestion);
    });
  };
  return [
    { dropdown: true, suggest },
    ...WORKFLOW_TRIGGER_CHARS.map(
      (trigger): Completion => ({
        trigger,
        dropdown: true,
        allowAfterWord: true,
        suggest,
      }),
    ),
  ];
};

const collectSchemaKeys = (schema: WorkflowFieldSchema, keys: Set<string>): void => {
  if (schema.kind === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      keys.add(key);
      collectSchemaKeys(value, keys);
    }
  } else if (schema.kind === "array") collectSchemaKeys(schema.items, keys);
  else if (schema.kind === "record") collectSchemaKeys(schema.values, keys);
  else if (schema.kind === "union") {
    for (const variant of schema.variants) collectSchemaKeys(variant, keys);
  }
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const createWorkflowYamlHighlighter = (workflows?: DefinedWorkflowModule): Highlighter => {
  const manifest = workflows?.manifest;
  const keywords = new Set([
    "inputs",
    "triggers",
    "steps",
    "type",
    "required",
    "with",
    "if",
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
    "then",
    "else",
    "switch",
    "cases",
    "default",
    "forEach",
    "as",
    "do",
    "true",
    "false",
    "null",
  ]);
  if (manifest) {
    for (const descriptor of [...manifest.inputs, ...manifest.triggers, ...manifest.actions]) {
      keywords.add(descriptor.kind);
      collectSchemaKeys(descriptor.config, keywords);
    }
  }
  const keywordPattern = new RegExp(`\\b(?:${[...keywords].sort().map(escapeRegex).join("|")})\\b`);
  return highlight.compile(
    [
      { kind: "placeholder", match: /\$\{\{\s*[^{}]+?\s*\}\}/ },
      { kind: "placeholder", match: /\b(?:inputs|trigger|steps)\.[A-Za-z_][A-Za-z0-9_.-]*\b/ },
      { kind: "string", match: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/ },
      { kind: "keyword", match: /\b[A-Za-z][A-Za-z0-9]*(?=\s*:)/ },
      { kind: "keyword", match: keywordPattern },
      { kind: "function", match: /\bnow\(\)/ },
      { kind: "number", match: /\b-?\d+(?:\.\d+)?\b/ },
      { kind: "operator", match: /[:{}\[\],-]/ },
      { kind: "comment", match: /#[^\n]*/ },
    ],
    { classPrefix: "doc-token-" },
  );
};
