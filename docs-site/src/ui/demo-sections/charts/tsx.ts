import { Chart } from "@k2b/ui";
import type { JsonValue } from "./examples/types";
import { formatNumber } from "./format";

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

const attribute = ([key, value]: [string, JsonValue]) =>
  typeof value === "string" ? `${key}=${JSON.stringify(value)}` : value === true ? key : `${key}={${jsLiteral(value, 2)}}`;

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
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return "";
  if (spec.block === "stats") {
    const items = Array.isArray(spec.items) ? spec.items : [];
    const cells = items.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return "";
      const { format, note, ...rest } = item;
      const props = Object.entries({
        ...rest,
        ...(typeof item.value === "number" ? { value: formatNumber(item.value, format) } : {}),
        ...(item.compare && typeof item.compare === "object" && !Array.isArray(item.compare) && typeof item.compare.value === "number"
          ? { compare: { ...item.compare, value: formatNumber(item.compare.value, format) } }
          : {}),
        ...(typeof note === "string" ? { sub: note } : {}),
      });
      return [`  <StatCell`, ...props.map((entry) => `    ${attribute(entry as [string, JsonValue])}`), "  />"].join("\n");
    });
    return [
      'import { StatCell, StatGrid } from "@k2b/ui";',
      "",
      `<StatGrid columns={${Math.max(1, Math.min(6, items.length))}}>`,
      ...cells,
      "</StatGrid>",
    ].join("\n");
  }
  // Other blocks are drawn by their own components; their portable form is the JSON alone.
  if ("block" in spec) return "";
  const { kind, ...props } = spec;
  const name = typeof kind === "string" ? member(kind) : undefined;
  const lines = name ? Object.entries(props).map(attribute) : [`kind=${JSON.stringify(kind)}`, ...Object.entries(props).map(attribute)];
  return ['import { Chart } from "@k2b/ui";', "", name ? `<Chart.${name}` : "<Chart", ...lines.map((line) => `  ${line}`), "/>"].join("\n");
}
