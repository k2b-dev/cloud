import { dates, i18n } from "@k2b/stdlib";
import type { CapabilityActionSentences, CapabilityPresentationCatalog } from "../contracts/capabilities";
import { canonicalLocale, localeFallbackChain, normalizeLocale } from "../shared/locale";
import { normalizeTimeZone } from "../shared/time";

/**
 * Action sentences: what an Action will do or did, in the words of its app. One pure renderer serves the
 * server (approval text for the CLI and notifications) and the chat in the browser, so both read the same.
 * It never knows an app: everything comes from the Action's presentation catalog and its schemas.
 */

export const CAPABILITY_SENTENCE_KEYS = ["approval", "done", "rejected", "notRun"] as const;
export type CapabilitySentenceKey = (typeof CAPABILITY_SENTENCE_KEYS)[number];

export const CAPABILITY_SENTENCE_MAX_CHARS = 200;
const MAX_PLACEHOLDERS = 6;
const MAX_VALUE_CHARS = 60;
const MAX_LIST_ITEMS = 3;
const MAX_RENDERED_CHARS = 240;
const MAX_FALLBACK_FIELDS = 2;
const MAX_LABELLED_FIELDS = 8;
const MAX_LABEL_CHARS = 40;
const MAX_DEPTH = 2;

export type CapabilitySentencePlaceholder = { source: "input" | "data"; path: string };
type Part = string | CapabilitySentencePlaceholder;

const PLACEHOLDER = /\{(input|data)\.([A-Za-z_][\w-]*(?:\[\])?(?:\.[A-Za-z_][\w-]*(?:\[\])?)*)\}/g;
const UNSAFE_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_CHARACTERS = new RegExp(UNSAFE_CHARACTER.source, "g");

/** Splits a template into text and placeholders, or names what makes it invalid. */
export const parseCapabilitySentence = (template: string): { parts: Part[] } | { error: string } => {
  const parts: Part[] = [];
  let index = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    parts.push(template.slice(index, match.index));
    parts.push({ source: match[1] as "input" | "data", path: match[2]! });
    index = match.index + match[0].length;
  }
  parts.push(template.slice(index));
  const text = parts.filter((part): part is string => typeof part === "string");
  if (text.some((part) => part.includes("{") || part.includes("}"))) {
    return { error: "uses a placeholder other than {input.path} or {data.path}" };
  }
  if (text.some((part) => UNSAFE_CHARACTER.test(part))) return { error: "contains control or direction characters" };
  if (parts.length - text.length > MAX_PLACEHOLDERS) return { error: `uses more than ${MAX_PLACEHOLDERS} placeholders` };
  return { parts: parts.filter((part) => part !== "") };
};

/** Placeholders of one valid template; empty for an invalid one. */
export const capabilitySentencePlaceholders = (template: string): CapabilitySentencePlaceholder[] => {
  const parsed = parseCapabilitySentence(template);
  return "parts" in parsed ? parsed.parts.filter((part): part is CapabilitySentencePlaceholder => typeof part !== "string") : [];
};

/** How the renderer reads one schema field: its label for the generic sentence and its date semantics. */
export type CapabilitySentenceField = {
  /** `input.<path>` or `data.<path>`. */
  path: string;
  /** Short field title in the reader's locale; only labelled input fields appear in the generic sentence. */
  label?: string;
  format?: "date" | "date-time";
};

/** Everything a reader needs to word one Action call, resolved for one locale. */
export type CapabilityActionWording = {
  title: string;
  sentences?: CapabilityActionSentences;
  fields?: readonly CapabilitySentenceField[];
};

/** The reader: locale for words and numbers, IANA time zone for instants (UTC when unknown or invalid). */
export type CapabilitySentenceContext = { locale: string; timeZone?: string };

const words = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      yes: "yes",
      no: "no",
      more: ({ count }: { count: number }) => `${count} more`,
      why: "Why",
    },
    de: {
      yes: "ja",
      no: "nein",
      more: ({ count }) => `${count} weitere`,
      why: "Warum",
    },
  },
});

export const checkCapabilitySentenceMessages = () => words.check();

/** The input field a model may add to an Action call that waits for approval: its own reason, never app input. */
export const CAPABILITY_APPROVAL_REASON_FIELD = "approvalReason";
export const CAPABILITY_APPROVAL_REASON_MAX_CHARS = 300;

/** The model's reason for one call as one bounded line, or `null` when it gave none. */
export const capabilityApprovalReason = (args: unknown): string | null => {
  const value =
    isRecord(args) && Object.hasOwn(args, CAPABILITY_APPROVAL_REASON_FIELD) ? args[CAPABILITY_APPROVAL_REASON_FIELD] : undefined;
  return typeof value === "string" ? plain(value, CAPABILITY_APPROVAL_REASON_MAX_CHARS) || null : null;
};

/** The label of the model's reason, so a reader never takes it for the app's own words. */
export const capabilityApprovalReasonLabel = (locale: string): string => words.resolve([locale]).t.why;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

const own = (value: unknown, key: string): unknown => (isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined);

/** Plain one-line text without control or direction characters, cut at a code point boundary. */
const plain = (value: string, max: number): string => {
  const text = value.replace(UNSAFE_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(text);
  return points.length <= max
    ? text
    : `${points
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A calendar date stays that date everywhere; an instant shows in the reader's time zone, like review details. */
const formatDate = (value: string, context: CapabilitySentenceContext, withTime: boolean): string | null => {
  if (DATE.test(value)) return dates.formatDate(`${value}T12:00:00.000Z`, { locale: context.locale, timeZone: "UTC" });
  if (Number.isNaN(new Date(value).getTime())) return null;
  const options = { locale: context.locale, timeZone: normalizeTimeZone(context.timeZone) };
  return withTime ? dates.formatDateTime(value, options) : dates.formatDate(value, options);
};

/** Keys that name a person or resource, in the order a reader recognizes them best. */
const DISPLAY_KEYS = ["displayName", "name", "title", "label", "email", "address", "path"] as const;

const formatValue = (
  value: unknown,
  format: CapabilitySentenceField["format"],
  context: CapabilitySentenceContext,
  depth = 0,
): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (DATE.test(text) || DATE_TIME.test(text)) {
      const formatted = formatDate(text, context, format !== "date");
      if (formatted) return formatted;
    }
    return plain(text, MAX_VALUE_CHARS) || null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? new Intl.NumberFormat(context.locale).format(value) : null;
  if (typeof value === "boolean") {
    const t = words.resolve([context.locale]).t;
    return value ? t.yes : t.no;
  }
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    const items = value.flatMap((item) => {
      const text = formatValue(item, format, context, depth + 1);
      return text ? [text] : [];
    });
    if (items.length === 0) return null;
    const shown = items.slice(0, items.length > MAX_LIST_ITEMS ? MAX_LIST_ITEMS - 1 : MAX_LIST_ITEMS);
    const rest = items.length - shown.length;
    const list = rest > 0 ? [...shown, words.resolve([context.locale]).t.more({ count: rest })] : shown;
    return new Intl.ListFormat(context.locale, { type: "conjunction" }).format(list);
  }
  if (isRecord(value)) {
    for (const key of DISPLAY_KEYS) {
      const text = formatValue(own(value, key), undefined, context, MAX_DEPTH);
      if (text) return text;
    }
  }
  return null;
};

/** Reads a dotted schema path such as `to[].name` from a value without touching inherited properties. */
const valueAt = (root: unknown, path: string): unknown => {
  let current: unknown[] = [root];
  let list = false;
  for (const segment of path.split(".")) {
    const many = segment.endsWith("[]");
    const key = many ? segment.slice(0, -2) : segment;
    current = current.flatMap((entry) => {
      const next = own(entry, key);
      if (!many) return next === undefined ? [] : [next];
      return Array.isArray(next) ? next : [];
    });
    list ||= many;
  }
  return list ? current : current[0];
};

/**
 * Renders one template, or `null` when a placeholder has no value to show: the caller then words the
 * call generically instead of showing a sentence with a gap.
 */
export const renderCapabilitySentence = (
  template: string,
  values: { input?: unknown; data?: unknown },
  fields: readonly CapabilitySentenceField[] | undefined,
  context: CapabilitySentenceContext,
): string | null => {
  const parsed = parseCapabilitySentence(template);
  if ("error" in parsed) return null;
  let text = "";
  for (const part of parsed.parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const path = `${part.source}.${part.path}`;
    const format = fields?.find((field) => field.path === path)?.format;
    const value = formatValue(valueAt(part.source === "input" ? values.input : values.data, part.path), format, context);
    if (value === null) return null;
    text += value;
  }
  return plain(text, MAX_RENDERED_CHARS) || null;
};

/** The generic sentence: the title with up to two labelled input fields, in schema order. */
export const capabilitySentenceFallback = (
  wording: CapabilityActionWording,
  input: unknown,
  context: CapabilitySentenceContext,
): string => {
  const details: string[] = [];
  for (const field of wording.fields ?? []) {
    if (details.length >= MAX_FALLBACK_FIELDS) break;
    if (!field.label || !field.path.startsWith("input.")) continue;
    const value = formatValue(valueAt(input, field.path.slice("input.".length)), field.format, context);
    if (value) details.push(`${field.label}: ${value}`);
  }
  return [plain(wording.title, MAX_VALUE_CHARS * 2), ...details].join(" · ");
};

/** What the call does, as one sentence: the app's approval sentence, else the generic sentence. */
export const capabilityActionSubject = (wording: CapabilityActionWording, input: unknown, context: CapabilitySentenceContext): string =>
  (wording.sentences?.approval ? renderCapabilitySentence(wording.sentences.approval, { input }, wording.fields, context) : null) ??
  capabilitySentenceFallback(wording, input, context);

/** The app's own sentence for one outcome, or `null` when it has none that renders for this call. */
export const capabilityActionOutcome = (
  wording: CapabilityActionWording,
  key: Exclude<CapabilitySentenceKey, "approval">,
  values: { input?: unknown; data?: unknown },
  context: CapabilitySentenceContext,
): string | null => {
  const template = wording.sentences?.[key];
  return template ? renderCapabilitySentence(template, values, wording.fields, context) : null;
};

/**
 * The sentences of one Action in the requested locale: the most specific locale that words the Action
 * provides the whole set, so one receipt never mixes two languages.
 */
export const resolveCapabilityActionSentences = (
  localId: string,
  catalog: Pick<CapabilityPresentationCatalog, "baseLocale" | "sentences" | "translations"> | undefined,
  requestedLocale: string,
): CapabilityActionSentences | undefined => {
  if (!catalog) return undefined;
  const base = normalizeLocale(catalog.baseLocale);
  const byLocale = new Map(
    Object.entries(catalog.translations).flatMap(([locale, translation]) => {
      const canonical = canonicalLocale(locale);
      return canonical ? [[canonical, translation] as const] : [];
    }),
  );
  for (const locale of localeFallbackChain(requestedLocale, base)) {
    const sentences = locale === base ? catalog.sentences?.[localId] : byLocale.get(locale)?.actions?.[localId]?.sentences;
    if (sentences) return sentences;
  }
  return undefined;
};

type JsonSchema = Record<string, unknown>;

/** The schema of one field path, following properties, array items, and union members. */
const schemaAt = (schema: unknown, path: string): JsonSchema | undefined => {
  let nodes: unknown[] = [schema];
  const expand = (node: unknown): JsonSchema[] => {
    if (!isRecord(node)) return [];
    const members = (["anyOf", "oneOf", "allOf"] as const).flatMap((keyword) => (Array.isArray(node[keyword]) ? node[keyword] : []));
    return [node, ...members.flatMap(expand)];
  };
  for (const segment of path.split(".")) {
    const many = segment.endsWith("[]");
    const key = many ? segment.slice(0, -2) : segment;
    nodes = nodes.flatMap(expand).flatMap((node) => {
      const property = own(node.properties, key);
      if (!many) return property === undefined ? [] : [property];
      return expand(property).flatMap((candidate) => (candidate.items === undefined ? [] : [candidate.items]));
    });
  }
  return nodes.flatMap(expand)[0];
};

const schemaFormat = (schema: JsonSchema | undefined): CapabilitySentenceField["format"] => {
  const nodes = [schema, ...(["anyOf", "oneOf"] as const).flatMap((keyword) => (Array.isArray(schema?.[keyword]) ? schema[keyword] : []))];
  const format = nodes.map((node) => own(node, "format")).find((value) => value === "date" || value === "date-time");
  return format as CapabilitySentenceField["format"];
};

const schemaTypes = (schema: JsonSchema): string[] => {
  const nodes = [schema, ...(["anyOf", "oneOf"] as const).flatMap((keyword) => (Array.isArray(schema[keyword]) ? schema[keyword] : []))];
  return nodes.flatMap((node) => {
    const type = own(node, "type");
    return Array.isArray(type)
      ? type.filter((entry): entry is string => typeof entry === "string")
      : typeof type === "string"
        ? [type]
        : [];
  });
};

/** Identifiers and concurrency tokens say nothing to a person. */
const OPAQUE_FIELD = /(^id$|Ids?$|Revision$|Hash$|Token$|Cursor$|^idempotencyKey$)/;
/** Long text such as a message body is not a detail of a one-line sentence. */
const MAX_DETAIL_TEXT_LENGTH = 1000;

/** A field description as a short title: its first clause, if that is short enough to label a value. */
const shortLabel = (description: unknown): string | undefined => {
  if (typeof description !== "string") return undefined;
  const clause = plain(description, 200)
    .split(/[.;:(]\s|[;:(]|\.$/)[0]!
    .trim();
  return clause && Array.from(clause).length <= MAX_LABEL_CHARS ? clause : undefined;
};

/**
 * The fields a reader needs to word one Action: the formats of the placeholders its sentences use and
 * the labelled top-level input fields that the generic sentence may show, in schema order and bounded.
 * `inputDescriptions` are the reader's localized field descriptions keyed by dotted path.
 */
export const capabilitySentenceFields = (input: {
  inputSchema: JsonSchema;
  dataSchema?: JsonSchema;
  sentences?: CapabilityActionSentences;
  inputDescriptions?: Readonly<Record<string, string>>;
}): CapabilitySentenceField[] => {
  const fields = new Map<string, CapabilitySentenceField>();
  const properties = isRecord(input.inputSchema.properties) ? input.inputSchema.properties : {};
  for (const [key, value] of Object.entries(properties)) {
    if (fields.size >= MAX_LABELLED_FIELDS) break;
    if (!isRecord(value) || OPAQUE_FIELD.test(key) || value.format === "uuid") continue;
    const types = schemaTypes(value);
    if (types.length > 0 && types.every((type) => type === "boolean" || type === "null")) continue;
    if (typeof value.maxLength === "number" && value.maxLength > MAX_DETAIL_TEXT_LENGTH) continue;
    const label = shortLabel(input.inputDescriptions?.[key] ?? value.description);
    if (!label) continue;
    const format = schemaFormat(value);
    fields.set(`input.${key}`, { path: `input.${key}`, label, ...(format ? { format } : {}) });
  }
  const templates = CAPABILITY_SENTENCE_KEYS.flatMap((key) => (input.sentences?.[key] ? [input.sentences[key]] : []));
  for (const placeholder of templates.flatMap(capabilitySentencePlaceholders)) {
    const path = `${placeholder.source}.${placeholder.path}`;
    if (fields.has(path)) continue;
    const format = schemaFormat(schemaAt(placeholder.source === "input" ? input.inputSchema : input.dataSchema, placeholder.path));
    fields.set(path, { path, ...(format ? { format } : {}) });
  }
  return [...fields.values()];
};
