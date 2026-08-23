import { type DateContext, dates, err, fail, ok, type Result } from "@k2b/stdlib";
import {
  type LiquidTemplateFilter,
  renderLiquidTemplate,
  validateLiquidTemplate as validateSharedLiquidTemplate,
} from "@valentinkolb/cloud/shared";
import { type BarcodeFormat, BarcodeRenderError, barcodeDataUrl } from "../barcode-rendering";
import type { DocumentTemplate } from "../contracts";

const TEMPLATE_MAX_BYTES = 200_000;

const DOCUMENT_TEMPLATE_ROOTS = new Set([
  "record",
  "table",
  "rows",
  "columns",
  "query",
  "document",
  "snapshot",
  "app",
  "business",
  "images",
  "primaryImage",
  "template",
  "date",
]);
export const DOCUMENT_SOURCE_ROOTS = new Set(["record", "table", "app", "business", "template", "date"]);
export const DOCUMENT_NUMBER_ROOTS = new Set(["record", "table", "template", "document", "series", "date", "app", "business"]);

const LIQUID_KEYWORDS = new Set([
  "and",
  "or",
  "not",
  "contains",
  "in",
  "true",
  "false",
  "nil",
  "null",
  "blank",
  "empty",
  "reversed",
  "continue",
]);
const LIQUID_TAGS_WITHOUT_EXPRESSIONS = new Set([
  "else",
  "endif",
  "endunless",
  "endfor",
  "endcase",
  "endcapture",
  "endcomment",
  "endraw",
  "break",
  "continue",
]);

export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const stripLiquidStringLiterals = (value: string): string =>
  value.replace(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g, (match) => " ".repeat(match.length));

const stripLiquidCommentBlocks = (value: string): string => value.replace(/{%-?\s*(comment|raw)\s*-?%}[\s\S]*?{%-?\s*end\1\s*-?%}/g, "");

const collectLiquidExpressionRoots = (expression: string): string[] => {
  const sanitized = stripLiquidStringLiterals(expression.replace(/\|\s*[A-Za-z_][A-Za-z0-9_]*/g, ""));
  const roots: string[] = [];
  for (const match of sanitized.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const name = match[0];
    const index = match.index ?? 0;
    const before = sanitized[index - 1] ?? "";
    const after = sanitized[index + name.length] ?? "";
    if (before === "." || after === ":" || LIQUID_KEYWORDS.has(name)) continue;
    roots.push(name);
  }
  return roots;
};

const liquidLocals = (frames: readonly (readonly string[])[]): Set<string> => {
  const locals = new Set<string>();
  for (const frame of frames) {
    for (const local of frame) locals.add(local);
  }
  return locals;
};

const addLiquidLocal = (frames: string[][], local: string): void => {
  frames[frames.length - 1]?.push(local);
};

const liquidExpressions = function* (source: string): Generator<{ expression: string; locals: ReadonlySet<string> }> {
  const cleanSource = stripLiquidCommentBlocks(source);
  const frames: string[][] = [[]];
  for (const match of cleanSource.matchAll(/{{-?\s*([\s\S]*?)\s*-?}}|{%-?\s*([A-Za-z_][A-Za-z0-9_]*)([\s\S]*?)\s*-?%}/g)) {
    const outputExpression = match[1];
    if (outputExpression !== undefined) {
      yield { expression: outputExpression, locals: liquidLocals(frames) };
      continue;
    }
    const tag = match[2]!;
    if (tag === "endfor") {
      if (frames.length > 1) frames.pop();
      continue;
    }
    if (LIQUID_TAGS_WITHOUT_EXPRESSIONS.has(tag) || tag === "comment" || tag === "raw") continue;
    const body = match[3] ?? "";
    if (tag === "for") {
      const forMatch = body.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/);
      if (forMatch) {
        yield { expression: forMatch[2]!, locals: liquidLocals(frames) };
        frames.push([forMatch[1]!, "forloop"]);
      }
      continue;
    }
    if (tag === "assign") {
      const localMatch = body.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      const assignMatch = body.match(/=\s*([\s\S]+)$/);
      if (assignMatch) yield { expression: assignMatch[1]!, locals: liquidLocals(frames) };
      if (localMatch) addLiquidLocal(frames, localMatch[1]!);
      continue;
    }
    if (tag === "capture") {
      const captureMatch = body.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (captureMatch) addLiquidLocal(frames, captureMatch[1]!);
      continue;
    }
    yield { expression: body, locals: liquidLocals(frames) };
  }
};

export const validateLiquidRoots = (source: string, roots: ReadonlySet<string>, label: string): Result<void> => {
  for (const { expression, locals } of liquidExpressions(source)) {
    for (const root of collectLiquidExpressionRoots(expression)) {
      if (roots.has(root) || locals.has(root)) continue;
      return fail(err.badInput(`${label} uses unknown Liquid variable "${root}"`));
    }
  }
  return ok();
};

export const datePatternContext = (date: Date, dateConfig?: DateContext) => {
  const iso = date.toISOString();
  const dateOnly = dates.formatDateKey(date, dateConfig);
  return {
    iso,
    date: dateOnly,
    yyyy: dateOnly.slice(0, 4),
    year: dateOnly.slice(0, 4),
    month: dateOnly.slice(5, 7),
    day: dateOnly.slice(8, 10),
    yyyyMMdd: dateOnly.replaceAll("-", ""),
  };
};

export const templatePatternContext = (template: Partial<Pick<DocumentTemplate, "id" | "shortId" | "name">> | null | undefined) => ({
  id: template?.shortId ?? "draft",
  name: template?.name ?? "Draft template",
});

const safeDocumentNumber = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[/:*?"<>|\\]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

const barcodeDataUrlFilter: LiquidTemplateFilter = (value, bcid = "code128", showText = false) => {
  if (typeof bcid !== "string") throw new Error("barcode_data_url requires a barcode type");
  if (showText !== true && showText !== false && showText !== undefined && showText !== null) {
    throw new Error("barcode_data_url show text flag must be a boolean");
  }

  const format: BarcodeFormat = { kind: "barcode", bcid, showText: showText === true };
  try {
    return barcodeDataUrl(value, format);
  } catch (error) {
    if (error instanceof BarcodeRenderError) throw new Error(error.message);
    throw error;
  }
};

export const documentLiquidFilters: Record<string, LiquidTemplateFilter> = {
  barcode_data_url: barcodeDataUrlFilter,
  json: (value) => JSON.stringify(value ?? null),
};

export const validateLiquidTemplate = (source: string): Result<void> => {
  if (utf8ByteLength(source) > TEMPLATE_MAX_BYTES) return fail(err.badInput("template is too large"));
  const valid = validateSharedLiquidTemplate(source, { filters: documentLiquidFilters });
  return valid.ok ? ok() : fail(err.badInput(valid.error));
};

export const validateDocumentLiquidTemplate = (
  source: string,
  label: string,
  roots: ReadonlySet<string> = DOCUMENT_TEMPLATE_ROOTS,
): Result<void> => {
  const valid = validateLiquidTemplate(source);
  if (!valid.ok) return valid;
  return validateLiquidRoots(source, roots, label);
};

const renderLiquid = async (
  template: string,
  data: Record<string, unknown>,
  options: { maxBytes?: number; escapeOutput?: boolean } = {},
): Promise<Result<string>> => {
  const valid = validateLiquidTemplate(template);
  if (!valid.ok) return valid;
  try {
    const rendered = renderLiquidTemplate(template, data, { filters: documentLiquidFilters, escapeOutput: options.escapeOutput });
    if (utf8ByteLength(rendered) > (options.maxBytes ?? TEMPLATE_MAX_BYTES)) return fail(err.badInput("rendered template is too large"));
    return ok(rendered);
  } catch (error) {
    return fail(err.badInput(error instanceof Error ? error.message : "template render failed"));
  }
};

export const renderLiquidText = async (
  template: string,
  data: Record<string, unknown>,
  maxBytes = TEMPLATE_MAX_BYTES,
): Promise<Result<string>> => renderLiquid(template, data, { maxBytes });

export const renderLiquidPlainText = async (
  template: string,
  data: Record<string, unknown>,
  maxBytes = TEMPLATE_MAX_BYTES,
): Promise<Result<string>> => renderLiquid(template, data, { maxBytes, escapeOutput: false });

export const documentNumberFor = (params: {
  template: Partial<Pick<DocumentTemplate, "id" | "shortId" | "name">> & { numberTemplate: string };
  documentShortId: string;
  createdAt?: Date;
  dateConfig?: DateContext;
  data?: Record<string, unknown>;
  series?: { id: string; value: number };
}): Result<string> => {
  const template = params.template.numberTemplate.trim();
  const valid = validateDocumentLiquidTemplate(template, "document number pattern", DOCUMENT_NUMBER_ROOTS);
  if (!valid.ok) return valid;
  try {
    const rendered = renderLiquidTemplate(
      template,
      {
        ...(params.data ?? {}),
        template: templatePatternContext(params.template),
        document: {
          ...((params.data?.document && typeof params.data.document === "object" && !Array.isArray(params.data.document)
            ? params.data.document
            : {}) as Record<string, unknown>),
          id: params.documentShortId,
        },
        series: params.series ?? { id: "draft", value: 0 },
        date: datePatternContext(params.createdAt ?? new Date(), params.dateConfig),
      },
      { filters: documentLiquidFilters },
    );
    const number = safeDocumentNumber(rendered);
    return number ? ok(number) : fail(err.badInput("document number pattern rendered an empty number"));
  } catch (error) {
    return fail(err.badInput(error instanceof Error ? error.message : "document number pattern render failed"));
  }
};
