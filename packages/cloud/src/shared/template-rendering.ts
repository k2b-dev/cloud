import { Liquid } from "liquidjs";

const TEMPLATE_MAX_BYTES = 200_000;
const RENDER_MAX_BYTES = 300_000;

type LiquidEngine = Liquid;
export type LiquidTemplateErrorReason = "render_too_large";

export class LiquidTemplateError extends Error {
  constructor(
    readonly reason: LiquidTemplateErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "LiquidTemplateError";
  }
}

export type LiquidTemplateFilter = Parameters<LiquidEngine["registerFilter"]>[1];
export type LiquidTemplateOptions = {
  filters?: Record<string, LiquidTemplateFilter>;
  escapeOutput?: boolean | ((value: unknown) => string);
  templateMaxBytes?: number;
  renderMaxBytes?: number;
  memoryLimit?: number;
};

const ALLOWED_TAGS = new Set([
  "if",
  "elsif",
  "else",
  "endif",
  "unless",
  "endunless",
  "for",
  "break",
  "continue",
  "endfor",
  "case",
  "when",
  "endcase",
  "assign",
  "capture",
  "endcapture",
  "comment",
  "endcomment",
  "raw",
  "endraw",
]);

const TEMPLATE_TAG_RE = /{%-?\s*([A-Za-z_][A-Za-z0-9_]*)\b/g;

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

export const escapeTemplateOutput = (value: unknown): string =>
  String(value).replace(/[&<>"'`=/]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "`":
        return "&#x60;";
      case "=":
        return "&#x3D;";
      case "/":
        return "&#x2F;";
      default:
        return char;
    }
  });

const createEngine = (options: LiquidTemplateOptions = {}) => {
  const outputEscape =
    typeof options.escapeOutput === "function" ? options.escapeOutput : options.escapeOutput === false ? undefined : escapeTemplateOutput;
  const engine = new Liquid({
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
    ...(outputEscape ? { outputEscape } : {}),
    parseLimit: options.templateMaxBytes ?? TEMPLATE_MAX_BYTES,
    renderLimit: options.renderMaxBytes ?? RENDER_MAX_BYTES,
    memoryLimit: options.memoryLimit ?? 2_000_000,
    cache: false,
    dynamicPartials: false,
    root: [],
    layouts: [],
    partials: [],
  });

  for (const [name, filter] of Object.entries(options.filters ?? {})) engine.registerFilter(name, filter);
  return engine;
};

const defaultEngine = createEngine();
const engineFor = (options: LiquidTemplateOptions = {}) => (Object.keys(options).length > 0 ? createEngine(options) : defaultEngine);

export const migrateLegacyMustacheTemplate = (template: string): string =>
  template
    .replace(/{{#\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}([\s\S]*?){{\/\s*\1\s*}}/g, "{% if $1 != blank %}$2{% endif %}")
    .replace(/{{\^\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}([\s\S]*?){{\/\s*\1\s*}}/g, "{% if $1 == blank %}$2{% endif %}");

export const validateLiquidTemplate = (
  template: string,
  options: LiquidTemplateOptions = {},
): { ok: true } | { ok: false; error: string } => {
  if (byteLength(template) > (options.templateMaxBytes ?? TEMPLATE_MAX_BYTES)) return { ok: false, error: "Template is too large" };
  for (const match of template.matchAll(TEMPLATE_TAG_RE)) {
    const tag = match[1]!;
    if (!ALLOWED_TAGS.has(tag)) return { ok: false, error: `Liquid tag "${tag}" is not allowed` };
  }
  try {
    engineFor(options).parse(template);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid Liquid template" };
  }
};

export const renderLiquidTemplate = (template: string, data: Record<string, unknown>, options: LiquidTemplateOptions = {}): string => {
  const valid = validateLiquidTemplate(template, options);
  if (!valid.ok) throw new Error(valid.error);
  const rendered = engineFor(options).parseAndRenderSync(template, data);
  if (byteLength(rendered) > (options.renderMaxBytes ?? RENDER_MAX_BYTES)) {
    throw new LiquidTemplateError("render_too_large", "Rendered template is too large");
  }
  return rendered;
};

export const liquidTemplateVariables = (template: string, options: LiquidTemplateOptions = {}): string[] => {
  const valid = validateLiquidTemplate(template, options);
  if (!valid.ok) throw new Error(valid.error);
  return engineFor(options).globalFullVariablesSync(template);
};
