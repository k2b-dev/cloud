import type { JsonValue } from "./examples/types";

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

/**
 * The description as Solid props of `<Chart>`: the same keys and values as the JSON, so the two views cannot drift
 * (`<Chart kind="…">` draws what its JSON describes).
 */
export function specToTsx(spec: JsonValue): string {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return "";
  // Blocks are drawn by their own components; their portable form is the JSON alone.
  if ("block" in spec) return "";
  const { kind, ...props } = spec;
  const attributes = [
    `kind=${JSON.stringify(kind)}`,
    ...Object.entries(props).map(([key, value]) =>
      typeof value === "string" ? `${key}=${JSON.stringify(value)}` : value === true ? key : `${key}={${jsLiteral(value, 2)}}`,
    ),
  ];
  return ['import { Chart } from "@k2b/ui";', "", "<Chart", ...attributes.map((line) => `  ${line}`), "/>"].join("\n");
}
