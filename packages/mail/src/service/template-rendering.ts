import {
  type LiquidTemplateFilter,
  LiquidTemplateError,
  liquidTemplateVariables,
  renderLiquidTemplate,
  validateLiquidTemplate,
} from "@k2b/cloud/shared";
import type { WorkflowActionContext, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { err, fail, ok, type Result } from "@k2b/stdlib";

const MAX_MAIL_TEMPLATE_BYTES = 200_000;
const MAX_MAIL_TEMPLATE_OUTPUT_BYTES = 3 * 1024 * 1024;

type MailTemplateOutput = "identifier" | "markdown" | "text";
type MailTemplateData = Record<string, unknown>;

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export const escapeMailMarkdownValue = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+!|>~:/@.-]/g, (character) => `&#${character.codePointAt(0)};`);

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
  escapeOutput: output === "markdown" ? escapeMailMarkdownValue : false,
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
