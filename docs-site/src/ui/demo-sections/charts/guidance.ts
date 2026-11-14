import { chartKinds } from "@k2b/editor/charts";
import type { ChartShowcaseKind } from "./examples";

/** Use and avoid stay short enough to read at a glance. */
export const GUIDANCE_LIMIT = 4;

/** Bullets about keys: the chart component behaves the same in every example, so the first example describes it. */
const keyboard = /arrow keys|home and end|\btab\b|\benter\b|\bescape\b/i;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Values of an enumerated schema field, through optional and default wrappers; lists and unions stay undefined. */
const enumValues = (field: unknown): string[] | undefined => {
  if (!record(field) || "element" in field) return undefined;
  if (typeof field.unwrap === "function") return enumValues(field.unwrap());
  if (!Array.isArray(field.options)) return undefined;
  const strings = field.options.filter((value): value is string => typeof value === "string");
  return strings.length && strings.length === field.options.length ? strings : undefined;
};

/** Object schemas of the description, also inside nested unions such as pie and donut. */
const members = (schema: unknown): Record<string, unknown>[] => {
  if (!record(schema)) return [];
  if (record(schema.shape)) return [schema.shape];
  return Array.isArray(schema.options) ? schema.options.flatMap(members) : [];
};

/** The literal a branch fixes for a field, such as `layout: "calendar"`; undefined when the field takes several values. */
const literal = (field: unknown): unknown => {
  if (!record(field)) return undefined;
  if ("value" in field) return field.value;
  return typeof field.unwrap === "function" ? literal(field.unwrap()) : undefined;
};

/**
 * The schema fields of a chart kind in this build, for the branch its layout selects (a calendar heatmap has other
 * fields than a plain one); undefined for blocks and kinds the schema does not describe. `schema` defaults to the
 * application schema; the Assistant's chart catalog also reads the chat's, with its limits.
 */
export const schemaShape = (kind: string, layout?: unknown, schema: unknown = chartKinds()) =>
  members(schema).find((member) => {
    const field = member.kind;
    if (!record(field) || (field.value !== kind && !enumValues(field)?.includes(kind))) return false;
    const fixed = literal(member.layout);
    return fixed === undefined || fixed === layout;
  });

/** The values an enumerated option of a chart kind accepts, read from the portable description's schema. */
export const schemaValues = (kind: string, name: string, layout?: unknown): string[] | undefined => {
  const shape = schemaShape(kind, layout);
  return shape ? enumValues(shape[name]) : undefined;
};

/**
 * What a kind's page lists, merged from all its examples: each option once (a detail such as `forecast.from` belongs
 * to `forecast`), only options this build's schema accepts, enumerated values as it accepts them, at most four reasons
 * to use and to avoid the kind, and the keyboard once.
 */
export const kindGuidance = (kind: ChartShowcaseKind) => {
  const first = kind.examples[0]!;
  const spec = first.spec;
  const chartKind =
    spec !== null && typeof spec === "object" && !Array.isArray(spec) && typeof spec.kind === "string" ? spec.kind : undefined;
  // The first example that names an option describes it.
  const merged = kind.examples
    .flatMap((example) => example.options)
    .filter((option, index, all) => all.findIndex((other) => other.name === option.name) === index);
  const names = new Set(merged.map((option) => option.name));
  const layout = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? spec.layout : undefined;
  const shape = chartKind ? schemaShape(chartKind, layout) : undefined;
  const root = (name: string) => name.split(".")[0]!;
  const options = merged
    .filter((option) => !option.name.includes(".") || !names.has(root(option.name)))
    // An option the build does not accept yet appears once its catalog step lands, like its slot.
    .filter((option) => !shape || option.name.split(", ").every((name) => root(name) in shape))
    .map((option) => {
      const values = chartKind && !option.name.includes(".") ? schemaValues(chartKind, option.name, layout) : undefined;
      return values ? { ...option, type: values.map((value) => JSON.stringify(value)).join(" | ") } : option;
    });
  const unique = (lists: string[][]) => [...new Set(lists.flat())];
  return {
    options,
    useFor: unique(kind.examples.map((example) => example.useFor)).slice(0, GUIDANCE_LIMIT),
    avoidFor: unique(kind.examples.map((example) => example.avoidFor)).slice(0, GUIDANCE_LIMIT),
    a11y: unique([first.a11y, ...kind.examples.slice(1).map((example) => example.a11y.filter((item) => !keyboard.test(item)))]),
  };
};
