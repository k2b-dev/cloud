import { Chart } from "@k2b/ui";
import type { JsonValue } from "./examples/types";
import { formatNumber } from "./format";
import { blockComponents } from "./resolve";

const identifier = /^[A-Za-z_$][\w$]*$/;
const WIDTH = 96;

/** A JSON value as a JavaScript literal: unquoted keys where possible, short values on one line. */
export function jsLiteral(value: JsonValue, indent = 0): string {
  const inline = (item: JsonValue): string => {
    if (Array.isArray(item)) return `[${item.map(inline).join(", ")}]`;
    if (item !== null && typeof item === "object")
      return Object.keys(item).length
        ? `{ ${Object.entries(item)
            .map(([key, entry]) => `${identifier.test(key) ? key : JSON.stringify(key)}: ${inline(entry)}`)
            .join(", ")} }`
        : "{}";
    return JSON.stringify(item);
  };
  const flat = inline(value);
  if (flat.length + indent <= WIDTH || value === null || typeof value !== "object") return flat;
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) return `[\n${value.map((item) => `${pad}${jsLiteral(item, indent + 2)},`).join("\n")}\n${close}]`;
  return `{\n${Object.entries(value)
    .map(([key, entry]) => `${pad}${identifier.test(key) ? key : JSON.stringify(key)}: ${jsLiteral(entry, indent + 2)},`)
    .join("\n")}\n${close}}`;
}

const attribute = ([key, value]: [string, JsonValue], indent = 2) =>
  typeof value === "string" ? `${key}=${JSON.stringify(value)}` : value === true ? key : `${key}={${jsLiteral(value, indent)}}`;

/** The namespace member of a kind, as `Chart.Line` for "line" (F7), when this build has it. */
const member = (kind: string) => {
  const name = kind[0]!.toUpperCase() + kind.slice(1);
  return typeof (Chart as unknown as Record<string, unknown>)[name] === "function" ? name : undefined;
};

/**
 * The description as Solid props: the same keys and values as the JSON, so the two views cannot drift. A chart kind
 * reads as its typed component (`<Chart.Line …>`, F7), which draws exactly what `<Chart kind="line" …>` and the JSON
 * draw; key figures read as the tiles they become.
 */
export function specToTsx(spec: JsonValue): string {
  // A list of amounts with a direction is the flow block: one FlowAmount per amount.
  if (Array.isArray(spec)) {
    const amounts = spec.filter((entry): entry is JsonObject => object(entry) && entry.type === "flow");
    if (!amounts.length) return "";
    return [
      'import { FlowAmount } from "@k2b/ui";',
      "",
      "<>",
      ...amounts.map((amount) => element("FlowAmount", without(amount, ["type"]), 2)),
      "</>",
    ].join("\n");
  }
  if (!object(spec)) return "";
  if (spec.block === "stats") {
    const items = Array.isArray(spec.items) ? spec.items : [];
    const cells = items.map((item) => {
      if (!object(item)) return "";
      const { format, note, ...rest } = item;
      const props = {
        ...rest,
        ...(typeof item.value === "number" ? { value: formatNumber(item.value, format) } : {}),
        ...(object(item.compare) && typeof item.compare.value === "number"
          ? { compare: { ...item.compare, value: formatNumber(item.compare.value, format) } }
          : {}),
        ...(typeof note === "string" ? { sub: note } : {}),
      };
      return element("StatCell", props, 2);
    });
    return [
      'import { StatCell, StatGrid } from "@k2b/ui";',
      "",
      `<StatGrid columns={${Math.max(1, Math.min(6, items.length))}}>`,
      ...cells,
      "</StatGrid>",
    ].join("\n");
  }
  if (spec.block === "table") {
    // The table's columns read their cells by id; types, formats, states and priorities pass as they are.
    const columns = (Array.isArray(spec.columns) ? spec.columns : []).filter(object).map((column) => {
      const { label, ...rest } = column;
      return { ...rest, header: label ?? "", value: column.id ?? "" };
    });
    const props = without({ ...spec, columns, ariaLabel: spec.title ?? "Table" }, [
      "block",
      "title",
      "subtitle",
      "search",
      "empty",
      "groupBy",
    ]);
    return ['import { DataTable } from "@k2b/ui";', "", element("DataTable", props, 0)].join("\n");
  }
  if (typeof spec.block === "string") {
    const name = blockComponents[spec.block];
    if (!name) return "";
    return [`import { ${name} } from "@k2b/ui";`, "", element(name, without(spec, ["block", "title", "subtitle"]), 0)].join("\n");
  }
  const { kind, ...props } = spec;
  const name = typeof kind === "string" ? member(kind) : undefined;
  return [
    'import { Chart } from "@k2b/ui";',
    "",
    element(name ? `Chart.${name}` : "Chart", name ? props : { kind: kind ?? null, ...props }, 0),
  ].join("\n");
}

type JsonObject = { [key: string]: JsonValue };
const object = (value: JsonValue | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const without = (value: JsonObject, keys: string[]): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/** A self-closing JSX element with one attribute per line, indented by `indent` spaces. */
const element = (name: string, props: JsonObject, indent: number) => {
  const pad = " ".repeat(indent);
  return [`${pad}<${name}`, ...Object.entries(props).map((entry) => `${pad}  ${attribute(entry, indent + 2)}`), `${pad}/>`].join("\n");
};
