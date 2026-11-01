/** Projects manifest JSON Schema into structural TypeScript. Runtime constraints remain owned by the dispatcher. */
export function schemaTypes(
  root: Record<string, unknown>,
  name: string,
  inputFields: ReadonlyArray<{ name: string; type: string; required: boolean }> = [],
): { type: string; declarations: string[] } {
  const declarations: string[] = [];
  const references = new Map<string, string>();
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}: invalid JSON Schema object`);
    return Object.fromEntries(Object.entries(value));
  };
  const literal = (value: unknown): string => {
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
      return `{ ${Object.entries(value)
        .map(([key, item]) => `${JSON.stringify(key)}: ${literal(item)}`)
        .join("; ")} }`;
    }
    return JSON.stringify(value);
  };
  const project = (value: unknown, includeInputFields = false): string => {
    if (value === true) return "unknown";
    if (value === false) return "never";
    const schema = object(value);
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
            .map(([key, item]) => `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${render(item)}`);
          if (includeInputFields) {
            for (const field of inputFields) fields.push(`${JSON.stringify(field.name)}${field.required ? "" : "?"}: ${field.type}`);
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
    return parts.length ? parts.map((part) => `(${part})`).join(" & ") : "unknown";
  };
  const render = (value: unknown): string => project(value);
  const type = project(root, true);
  return { type, declarations };
}
