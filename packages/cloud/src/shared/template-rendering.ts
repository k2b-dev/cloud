import {
  AssertionError,
  Context,
  defaultOperators,
  type Emitter,
  type FilterImplOptions,
  Liquid,
  LiquidError,
  type Operators,
  toValue,
  toValueSync,
} from "liquidjs";

const TEMPLATE_MAX_BYTES = 200_000;
const RENDER_MAX_BYTES = 300_000;
// Synchronous rendering blocks every request in the app process. Legitimate templates
// take milliseconds; keep this well below normal request latency budgets.
const RENDER_TIMEOUT_MS = 1_000;

type LiquidEngine = Liquid;
export type LiquidTemplateErrorReason = "render_too_large" | "render_timeout" | "render_memory_limit";

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
  renderTimeoutMs?: number;
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

class BoundedEmitter implements Emitter {
  buffer = "";
  private bytes = 0;
  private lastCodeUnit = 0;

  constructor(private readonly maxBytes: number) {}

  write(input: unknown): void {
    const value: unknown = toValue(input);
    // Match LiquidJS's emitter: nil is empty, arrays concatenate their elements.
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) this.write(item);
      return;
    }
    const chunk = String(value);
    if (!chunk) return;
    const last = this.lastCodeUnit;
    const first = chunk.charCodeAt(0);
    // A surrogate pair split across writes encodes as four bytes, rather than six.
    const paired = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
    const bytes = this.bytes + byteLength(chunk) - (paired ? 2 : 0);
    if (bytes > this.maxBytes) throw new LiquidTemplateError("render_too_large", "Rendered template is too large");
    this.bytes = bytes;
    this.lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    this.buffer += chunk;
  }
}

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

const expandedTextLength = (input: unknown): number => {
  const value: unknown = toValue(input);
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((length: number, item: unknown) => length + expandedTextLength(item), 0);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value).length;
  return 0;
};

const createEngine = (options: LiquidTemplateOptions = {}) => {
  const outputEscape =
    typeof options.escapeOutput === "function" ? options.escapeOutput : options.escapeOutput === false ? undefined : escapeTemplateOutput;
  const operators: Operators = {};
  for (const [name, handler] of Object.entries(defaultOperators)) {
    operators[name] = (...args: [unknown, Context] | [unknown, unknown, Context]): boolean => {
      const result: boolean = Reflect.apply(handler, undefined, args);
      const context = args[args.length - 1];
      if (context instanceof Context) context.renderLimit.check(performance.now());
      return result;
    };
  }
  const engine = new Liquid({
    operators,
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
    ...(outputEscape ? { outputEscape } : {}),
    parseLimit: options.templateMaxBytes ?? TEMPLATE_MAX_BYTES,
    renderLimit: options.renderTimeoutMs ?? RENDER_TIMEOUT_MS,
    memoryLimit: options.memoryLimit ?? 2_000_000,
    cache: false,
    dynamicPartials: false,
    root: [],
    layouts: [],
    partials: [],
  });

  const renderTemplates = engine.renderer.renderTemplates.bind(engine.renderer);
  engine.renderer.renderTemplates = function* (templates, context, emitter) {
    // Capture renders without an emitter; bound its intermediate buffer as well.
    const result = yield* renderTemplates(
      templates,
      context,
      emitter ?? new BoundedEmitter(Math.max(options.renderMaxBytes ?? RENDER_MAX_BYTES, RENDER_MAX_BYTES)),
    );
    // LiquidJS checks before templates and every loop body (even an empty one).
    // Check after them too, so a slow final filter cannot return over budget.
    context.renderLimit.check(performance.now());
    return result;
  };

  for (const name of ["push", "concat", "unshift", "map"]) {
    const filter = engine.filters[name];
    if (!filter) continue;
    const handler = typeof filter === "function" ? filter : filter.handler;
    const bounded: FilterImplOptions = function* (...args: [unknown, ...unknown[]]): Generator<unknown, unknown, unknown> {
      const result: unknown = yield handler.apply(this, args);
      // Charge added text only; charging the left array again would compound.
      this.context.memoryLimit.use(expandedTextLength(name === "map" ? result : args[1]));
      return result;
    };
    engine.registerFilter(name, typeof filter === "function" ? bounded : { ...filter, handler: bounded });
  }
  for (const [name, filter] of Object.entries(options.filters ?? {})) engine.registerFilter(name, filter);
  for (const [name, filter] of Object.entries(engine.filters)) {
    const handler = typeof filter === "function" ? filter : filter.handler;
    const timed: FilterImplOptions = function* (...args: [unknown, ...unknown[]]): Generator<unknown, unknown, unknown> {
      const result: unknown = yield handler.apply(this, args);
      this.context.renderLimit.check(performance.now());
      return result;
    };
    engine.registerFilter(name, typeof filter === "function" ? timed : { ...filter, handler: timed });
  }
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
  const engine = engineFor(options);
  const context = new Context(data, engine.options, { sync: true }, { liquid: engine });
  const emitter = new BoundedEmitter(options.renderMaxBytes ?? RENDER_MAX_BYTES);
  try {
    toValueSync(engine.renderer.renderTemplates(engine.parse(template), context, emitter));
    return emitter.buffer;
  } catch (error) {
    // LiquidJS wraps emitter and limiter failures in RenderError.originalError.
    let original = error;
    while (original instanceof LiquidError && original.originalError) original = original.originalError;
    if (original instanceof LiquidTemplateError) throw original;
    if (original instanceof AssertionError) {
      if (original.message === "template render limit exceeded") {
        throw new LiquidTemplateError("render_timeout", "Template rendering exceeded its time budget");
      }
      if (original.message === "memory alloc limit exceeded") {
        throw new LiquidTemplateError("render_memory_limit", "Template rendering exceeded its memory limit");
      }
    }
    throw error;
  }
};

export const liquidTemplateVariables = (template: string, options: LiquidTemplateOptions = {}): string[] => {
  const valid = validateLiquidTemplate(template, options);
  if (!valid.ok) throw new Error(valid.error);
  return engineFor(options).globalFullVariablesSync(template);
};
