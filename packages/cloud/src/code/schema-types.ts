import { createHash } from "node:crypto";

/** Projects manifest JSON Schema into structural TypeScript. Runtime constraints remain owned by the dispatcher. */
export function schemaTypes(
  root: Record<string, unknown>,
  name: string,
  inputFields: ReadonlyArray<{ name: string; type: string; required: boolean }> = [],
  shapes?: { types: Map<string, string>; names: Set<string> },
  namedRoot?: { name: string; types: Map<string, string> },
): { type: string; declarations: string[] } {
  const declarations: string[] = [];
  const references = new Map<string, string>();
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}: invalid JSON Schema object`);
    return Object.fromEntries(Object.entries(value));
  };
  const property = (key: string) => (/^[a-z_$][\w$]*$/i.test(key) ? key : JSON.stringify(key));
  const literal = (value: unknown): string => {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
      return `{ ${Object.entries(value)
        .map(([key, item]) => `${property(key)}: ${literal(item)}`)
        .join("; ")} }`;
    }
    return JSON.stringify(value);
  };
  const project = (value: unknown, includeInputFields = false): string => {
    if (value === true) return "unknown";
    if (value === false) return "never";
    const schema = object(value);
    if (schema.not === true || (schema.not !== null && typeof schema.not === "object" && Object.keys(schema.not).length === 0))
      return "never";
    const parts: string[] = [];
    if (schema.$ref !== undefined) {
      const ref = schema.$ref;
      if (typeof ref !== "string" || (ref !== "#" && !ref.startsWith("#/")))
        throw new Error(`${name}: only local JSON Schema refs are supported`);
      let alias = references.get(ref);
      if (!alias) {
        alias = `${name}Ref${references.size}`;
        references.set(ref, alias);
        let target: unknown = root;
        for (const part of ref === "#" ? [] : ref.slice(2).split("/")) {
          if (target === undefined) throw new Error(`${name}: unresolved JSON Schema ref ${ref}`);
          target = object(target)[decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~")];
        }
        if (target === undefined) throw new Error(`${name}: unresolved JSON Schema ref ${ref}`);
        declarations.push(`type ${alias} = ${render(target)};`);
      }
      parts.push(alias);
    }
    if (Object.hasOwn(schema, "const")) parts.push(literal(schema.const));
    if (Array.isArray(schema.enum)) parts.push(`(${schema.enum.map(literal).join(" | ") || "never"})`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(schema[key])) {
        const separator = key === "allOf" ? " & " : " | ";
        parts.push(`(${schema[key].map(render).join(separator) || (key === "allOf" ? "unknown" : "never")})`);
      }
    }
    const structural = (type: unknown): string => {
      switch (type) {
        case "string":
          return "string";
        case "number":
        case "integer":
          return "number";
        case "boolean":
          return "boolean";
        case "null":
          return "null";
        case "array": {
          const prefix = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : undefined);
          if (Array.isArray(prefix)) {
            const required = typeof schema.minItems === "number" ? schema.minItems : 0;
            const tail = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
            return `[${prefix.map((item, i) => `${render(item)}${i >= required ? "?" : ""}`).join(", ")}${tail === false ? "" : `${prefix.length ? ", " : ""}...Array<${render(tail ?? true)}>`}]`;
          }
          return `Array<${render(schema.items ?? true)}>`;
        }
        case "object": {
          const props = object(schema.properties ?? {});
          const required = new Set(Array.isArray(schema.required) ? schema.required : []);
          const fields = Object.entries(props)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => {
              const schema = item && typeof item === "object" ? object(item) : {};
              const description =
                typeof schema.title === "string"
                  ? schema.title
                  : typeof schema.description === "string"
                    ? (schema.description.split(/(?<=[.!?])\s/)[0] ?? "")
                    : "";
              const summary = description.length > 40 ? `${description.slice(0, 37).replace(/\s+\S*$/, "")}…` : description;
              const comment = description ? `/** ${summary.replaceAll("*/", "* /").replace(/[\r\n]+/g, " ")} */ ` : "";
              return `${comment}${property(key)}${required.has(key) ? "" : "?"}: ${render(item)}`;
            });
          if (includeInputFields) {
            for (const field of inputFields) fields.push(`${property(field.name)}${field.required ? "" : "?"}: ${field.type}`);
          }
          // JSON Schema applies additionalProperties only to undeclared keys; TS index signatures apply to all keys.
          // Use unknown for a mixed object so known fields retain their exact type without rejecting valid JSON.
          if (schema.additionalProperties !== false || schema.patternProperties) {
            const values = Object.values(object(schema.patternProperties ?? {})).map(render);
            if (schema.additionalProperties !== false) values.push(render(schema.additionalProperties ?? true));
            fields.push(`[key: string]: ${Object.keys(props).length ? "unknown" : values.join(" | ") || "unknown"}`);
          }
          return fields.length ? `{ ${fields.join("; ")} }` : "Record<string, never>";
        }
        case undefined:
          return "unknown";
        default:
          throw new Error(`${name}: unsupported JSON Schema type ${String(type)}`);
      }
    };
    if (Array.isArray(schema.type)) parts.push(`(${schema.type.map(structural).join(" | ")})`);
    else if (schema.type !== undefined || schema.properties || schema.items)
      parts.push(structural(schema.type ?? (schema.properties ? "object" : "array")));
    return parts.length > 1 ? parts.map((part) => `(${part})`).join(" & ") : (parts[0] ?? "unknown");
  };
  // One pool per generated module lets operations, events and page schemas reuse shapes.
  // Numbered legacy refs depend on the selected catalog, so keep their shapes local.
  // Documentation must not duplicate an identical type. Keep JSON string literals intact:
  // a literal can itself contain text that looks like a JSDoc comment.
  const structuralKey = (type: string) =>
    type.replace(/("(?:\\.|[^"\\])*")|\/\*\*[\s\S]*?\*\/\s*/g, (_match, literal: string | undefined) => literal ?? "");
  const share = (type: string): string => {
    if (!shapes || (!type.startsWith("{") && !type.startsWith("[")) || /\b(?:Input|Data|Event)\d+Ref\d+\b/.test(type)) return type;
    const key = structuralKey(type);
    let alias = shapes.types.get(key);
    if (!alias) {
      const hash = createHash("sha256").update(key).digest("hex");
      alias = `S${hash.slice(0, 12)}`;
      if (shapes.names.has(alias)) alias = `S${hash}`;
      shapes.types.set(key, alias);
      shapes.names.add(alias);
      declarations.push(`type ${alias} = ${type};`);
    }
    return alias;
  };
  const render = (value: unknown): string => share(project(value));
  const type = project(root, true);
  if (namedRoot && /^(?:[\{\[]|Array<|Record<)/.test(type)) {
    const existing = namedRoot.types.get(type);
    if (existing) return { type: existing, declarations };
    namedRoot.types.set(type, namedRoot.name);
  }
  return { type, declarations };
}
