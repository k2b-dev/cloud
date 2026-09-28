import {
  LiquidTemplateError,
  type LiquidTemplateFilter,
  liquidTemplateVariables,
  renderLiquidTemplate,
  validateLiquidTemplate,
} from "@k2b/cloud/shared";
import type { WorkflowActionContext, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { err, fail, ok, type Result } from "@k2b/stdlib";

const MAX_MAIL_TEMPLATE_BYTES = 200_000;
const MAX_MAIL_TEMPLATE_OUTPUT_BYTES = 3 * 1024 * 1024;

/**
 * `markdown` is rendered straight to email HTML, so values never form Markdown, HTML, or links.
 * `editable_markdown` lands in a draft body that a person reads and edits, so values stay as typed.
 */
type MailTemplateOutput = "identifier" | "editable_markdown" | "markdown" | "text";
type MailTemplateData = Record<string, unknown>;

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

// Four columns of indentation open a code block, which would show escapes verbatim. Rendered Markdown collapses the rest.
const capLineIndent = (indent: string): string => (indent.length > 3 || indent.includes("\t") ? "   " : indent);

export const escapeMailMarkdownValue = (value: unknown): string =>
  String(value)
    .replace(/^[ \t]+/gm, capLineIndent)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+!|>~^=$:/@.-]/g, (character) => `&#${character.codePointAt(0)};`);

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

const escapeEditableMarkdownLine = (line: string): string =>
  line
    .replace(/[\\`*_[\]<~^=:$|{}&%]/g, (character, offset: number) => {
      const previous = line[offset - 1] ?? "";
      const next = line[offset + 1] ?? "";
      if (character === "_") return WORD_CHARACTER.test(previous) && WORD_CHARACTER.test(next) ? "_" : "\\_";
      // Runs such as `==` (highlight) and `:::` (notice blocks) are syntax; single characters are not.
      if (character === "=" || character === ":") return previous === character || next === character ? `\\${character}` : character;
      if (character === "&") return /^&#?[a-z0-9]+;/i.test(line.slice(offset)) ? "\\&" : "&";
      if (character === "%") return previous === "{" ? "\\%" : "%";
      return `\\${character}`;
    })
    .replace(/^[ \t]+/, capLineIndent)
    .replace(/^( *)(?:([#>+=:-])|(\d{1,9})([.)]))/, (_match, indent: string, marker?: string, digits?: string, delimiter?: string) =>
      marker ? `${indent}\\${marker}` : `${indent}${digits}\\${delimiter}`,
    )
    // A trailing ` #` run would close a heading instead of staying text.
    .replace(/([ \t])(#+[ \t]*)$/, "$1\\$2");

/**
 * Escapes a value for Markdown that a person still reads and edits.
 *
 * Only characters that would start Markdown, HTML, or Liquid syntax get a backslash, so names,
 * addresses, and subjects read as typed. Plain addresses and URLs may become links, as when typed.
 */
export const escapeMailEditableMarkdownValue = (value: unknown): string =>
  // Markdown also starts a new line after a lone carriage return.
  String(value)
    .split(/\r\n?|\n/)
    .map(escapeEditableMarkdownLine)
    .join("\n");

const OUTPUT_ESCAPES: Record<MailTemplateOutput, ((value: unknown) => string) | false> = {
  identifier: false,
  editable_markdown: escapeMailEditableMarkdownValue,
  markdown: escapeMailMarkdownValue,
  text: false,
};

const padStart: LiquidTemplateFilter = (value: unknown, width: unknown, fill: unknown = "0") => {
  const parsedWidth = typeof width === "number" ? width : Number(width);
  const parsedFill = String(fill);
  if (!Number.isSafeInteger(parsedWidth) || parsedWidth < 1 || parsedWidth > 120) {
    throw new TypeError("pad_start width must be an integer between 1 and 120");
  }
  if ([...parsedFill].length !== 1) throw new TypeError("pad_start fill must be one character");
  return String(value).padStart(parsedWidth, parsedFill);
};

const MAIL_LIQUID_FILTERS = { pad_start: padStart } satisfies Record<string, LiquidTemplateFilter>;

const renderOptions = (output: MailTemplateOutput) => ({
  filters: MAIL_LIQUID_FILTERS,
  escapeOutput: OUTPUT_ESCAPES[output],
  templateMaxBytes: MAX_MAIL_TEMPLATE_BYTES,
  renderMaxBytes: MAX_MAIL_TEMPLATE_OUTPUT_BYTES,
  memoryLimit: 8 * 1024 * 1024,
});

export const validateMailLiquidTemplate = (
  source: string,
  options: { allowedRoots?: readonly string[]; allowedVariables?: readonly string[]; output?: MailTemplateOutput } = {},
): Result<void> => {
  if (bytes(source) > MAX_MAIL_TEMPLATE_BYTES) return fail(err.badInput("Mail template is too large"));
  const liquid = validateLiquidTemplate(source, renderOptions(options.output ?? "text"));
  if (!liquid.ok) return fail(err.badInput(liquid.error));
  if (options.allowedVariables || options.allowedRoots) {
    try {
      const variables = liquidTemplateVariables(source, renderOptions(options.output ?? "text"));
      if (options.allowedVariables) {
        const allowed = new Set(options.allowedVariables);
        const unsupported = variables.find((variable) => !allowed.has(variable));
        if (unsupported) return fail(err.badInput(`Mail template variable "${unsupported}" is not available here`));
      } else {
        const allowed = new Set(options.allowedRoots);
        const unsupported = variables.find((variable) => !allowed.has(variable.split(".", 1)[0] ?? ""));
        if (unsupported) return fail(err.badInput(`Mail template variable "${unsupported}" is not available here`));
      }
    } catch (error) {
      return fail(err.badInput(error instanceof Error ? error.message : "Mail template variables could not be inspected"));
    }
  }
  return ok();
};

export const mailLiquidTemplateVariables = (source: string, output: MailTemplateOutput = "text"): Result<string[]> => {
  const valid = validateMailLiquidTemplate(source, { output });
  if (!valid.ok) return valid;
  try {
    return ok(liquidTemplateVariables(source, renderOptions(output)));
  } catch (error) {
    return fail(err.badInput(error instanceof Error ? error.message : "Mail template variables could not be inspected"));
  }
};

export const renderMailLiquidTemplate = (source: string, data: MailTemplateData, output: MailTemplateOutput = "text"): Result<string> => {
  const valid = validateMailLiquidTemplate(source, { output });
  if (!valid.ok) return valid;
  try {
    const rendered = renderLiquidTemplate(source, data, renderOptions(output));
    if (bytes(rendered) > MAX_MAIL_TEMPLATE_OUTPUT_BYTES) {
      return fail(err.badInput("Rendered Mail template is too large"));
    }
    return ok(rendered);
  } catch (error) {
    if (error instanceof LiquidTemplateError) {
      return fail(Object.assign(err.badInput(error.message), { reason: error.reason }));
    }
    return fail(err.badInput(error instanceof Error ? error.message : "Mail template could not be rendered"));
  }
};

const mailWorkflowTemplateData = (
  context: Pick<WorkflowActionContext, "invocation" | "variableSnapshot">,
): Record<string, WorkflowJsonValue> => ({
  inputs: context.invocation.inputs,
  context: {
    ...(context.invocation.context ?? {}),
    actor: context.invocation.actor,
    occurredAt: context.invocation.occurredAt,
  },
  ...context.variableSnapshot(),
});

export const renderMailWorkflowTemplate = (
  context: Pick<WorkflowActionContext, "invocation" | "variableSnapshot">,
  source: string,
  output: MailTemplateOutput = "text",
): string => {
  const rendered = renderMailLiquidTemplate(source, mailWorkflowTemplateData(context), output);
  if (!rendered.ok) throw rendered.error;
  return rendered.data;
};

export const migrateWorkflowTextTemplateToLiquid = (source: string): string =>
  source.replace(/\$\{\{\s*([^{}]+?)\s*\}\}/g, (_match, expression: string) => `{{ ${expression.trim()} }}`);

export const migrateReferenceTemplateToLiquid = (source: string): string =>
  source.replace(/{{[\s\S]*?}}|{%[\s\S]*?%}|\{sequence:([1-9]\d?)\}|\{sequence\}|\{year\}/g, (match, width: string | undefined) => {
    if (match.startsWith("{{") || match.startsWith("{%")) return match;
    if (width) return `{{ sequence | pad_start: ${width} }}`;
    return match === "{sequence}" ? "{{ sequence }}" : "{{ year }}";
  });
