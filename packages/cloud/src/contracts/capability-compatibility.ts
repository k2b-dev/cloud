import { z } from "zod";
import type { CapabilityActionManifest, CapabilityQueryManifest } from "./capabilities";

/**
 * A consumer-owned expectation of one provider capability: its kind, the input
 * the consumer sends, and the minimum result data it reads.
 */
export type CapabilityContract = {
  kind: "query" | "action";
  idempotency?: "required";
  input: z.ZodType;
  data: z.ZodType;
};

export type CapabilityContractCandidate =
  | { kind: "query"; operation: CapabilityQueryManifest }
  | { kind: "action"; operation: CapabilityActionManifest };

export type CapabilityContractIssue = {
  /** `kind`, `idempotency`, and `stream` concern the operation; `input` and `data` its published schemas. */
  code: "kind" | "idempotency" | "stream" | "input" | "data";
  /** JSON path inside the input or data schema, `$` for the root. */
  path: string;
  message: string;
};

type Json = Record<string, unknown>;
type Side = { schema: unknown; root: Json };
type Mode = "input" | "data";
type PathIssue = { path: string; message: string };
const add = (issues: PathIssue[], path: string, message: string) => {
  issues.push({ path, message });
};

const MAX_DEPTH = 32;
const IGNORED_KEYWORDS = new Set(["$schema", "$id", "$defs", "definitions", "title", "description", "default", "examples", "readOnly"]);
const SUPPORTED_KEYWORDS = new Set([
  ...IGNORED_KEYWORDS,
  "type",
  "const",
  "enum",
  "anyOf",
  "oneOf",
  "allOf",
  "$ref",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

const deref = (side: Side, depth: number): Side | null => {
  let current = side.schema;
  for (let hops = 0; isObject(current) && typeof current.$ref === "string"; hops++) {
    if (hops > depth) return null;
    const ref = current.$ref;
    if (ref === "#") current = side.root;
    else if (ref.startsWith("#/$defs/")) current = (side.root.$defs as Json | undefined)?.[ref.slice(8)];
    else return null;
  }
  return { schema: current, root: side.root };
};

/** `true`, `{}`, and a schema with only annotations accept every value. */
const acceptsAnything = (schema: unknown): boolean =>
  schema === true || (isObject(schema) && Object.keys(schema).every((key) => IGNORED_KEYWORDS.has(key)));

const typeSet = (schema: Json): Set<string> | null => {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type.filter((entry): entry is string => typeof entry === "string"));
  return null;
};

const valuesOf = (schema: Json): unknown[] | null => {
  if ("const" in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return null;
};

const jsonType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;

const typeAllows = (allowed: Set<string>, type: string): boolean => allowed.has(type) || (type === "integer" && allowed.has("number"));

const patternMatches = (pattern: string, value: string): boolean => {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return false;
  }
};

/** Checks one literal value against a provider or contract schema. Unknown keywords never pass. */
const valueIssue = (value: unknown, sup: Side, depth: number): string | null => {
  const resolved = deref(sup, depth);
  if (!resolved) return "uses an unsupported reference";
  const schema = resolved.schema;
  if (acceptsAnything(schema)) return null;
  if (!isObject(schema)) return "is not a JSON Schema object";
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && !branches.some((branch) => valueIssue(value, { schema: branch, root: sup.root }, depth + 1) === null)) {
      return `value ${JSON.stringify(value)} is not accepted`;
    }
  }
  const values = valuesOf(schema);
  if (values && !values.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    return `value ${JSON.stringify(value)} is not accepted`;
  }
  const types = typeSet(schema);
  if (types && !typeAllows(types, jsonType(value))) return `value ${JSON.stringify(value)} has the wrong type`;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return "value is too short";
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return "value is too long";
    if (typeof schema.pattern === "string" && !patternMatches(schema.pattern, value)) return "value does not match the pattern";
  }
  return null;
};

type Bound = { value: number; exclusive: boolean };
const lowerBound = (schema: Json): Bound | null =>
  typeof schema.exclusiveMinimum === "number"
    ? { value: schema.exclusiveMinimum, exclusive: true }
    : typeof schema.minimum === "number"
      ? { value: schema.minimum, exclusive: false }
      : null;
const upperBound = (schema: Json): Bound | null =>
  typeof schema.exclusiveMaximum === "number"
    ? { value: schema.exclusiveMaximum, exclusive: true }
    : typeof schema.maximum === "number"
      ? { value: schema.maximum, exclusive: false }
      : null;
const withinLower = (sub: Bound | null, sup: Bound | null): boolean =>
  !sup || (sub !== null && (sub.value > sup.value || (sub.value === sup.value && (sub.exclusive || !sup.exclusive))));
const withinUpper = (sub: Bound | null, sup: Bound | null): boolean =>
  !sup || (sub !== null && (sub.value < sup.value || (sub.value === sup.value && (sub.exclusive || !sup.exclusive))));

const withinMin = (sub: unknown, sup: unknown): boolean => typeof sup !== "number" || (typeof sub === "number" && sub >= sup);
const withinMax = (sub: unknown, sup: unknown): boolean => typeof sup !== "number" || (typeof sub === "number" && sub <= sup);

/**
 * Collects why `sub` may contain a value that `sup` rejects. The check is
 * deliberately conservative: an unsupported keyword is an issue, never a pass.
 */
const subsetIssues = (sub: Side, sup: Side, path: string, mode: Mode, depth: number, issues: PathIssue[]): void => {
  if (issues.length >= 5) return;
  if (depth > MAX_DEPTH) {
    add(issues, path, `schema is nested too deeply`);
    return;
  }
  const subResolved = deref(sub, depth);
  const supResolved = deref(sup, depth);
  if (!subResolved || !supResolved) {
    add(issues, path, `uses an unsupported reference`);
    return;
  }
  const subSchema = subResolved.schema;
  const supSchema = supResolved.schema;
  if (acceptsAnything(supSchema)) return;
  if (!isObject(supSchema)) {
    if (supSchema === false) add(issues, path, `is not accepted`);
    return;
  }
  if (acceptsAnything(subSchema)) {
    add(issues, path, `is unconstrained but must match the contract`);
    return;
  }
  if (!isObject(subSchema)) return;
  const unsupported = [...Object.keys(subSchema), ...Object.keys(supSchema)].find((key) => !SUPPORTED_KEYWORDS.has(key));
  if (unsupported) {
    add(issues, path, `uses the unsupported keyword ${unsupported}`);
    return;
  }
  const next = (schema: unknown, side: Side): Side => ({ schema, root: side.root });

  // A union on the narrower side must fit branch by branch.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = subSchema[keyword];
    if (!Array.isArray(branches)) continue;
    const { [keyword]: _branches, ...rest } = subSchema;
    for (const branch of branches) {
      const merged = isObject(branch) ? { ...rest, ...branch } : branch;
      subsetIssues(next(merged, subResolved), supResolved, path, mode, depth + 1, issues);
    }
    return;
  }
  if (Array.isArray(subSchema.allOf)) {
    // An intersection is narrower than each part; one fitting part is enough.
    const { allOf, ...rest } = subSchema;
    const fits = allOf.some((part) => {
      const found: PathIssue[] = [];
      subsetIssues(next(isObject(part) ? { ...rest, ...part } : part, subResolved), supResolved, path, mode, depth + 1, found);
      return found.length === 0;
    });
    if (!fits) add(issues, path, `no part of the intersection matches the contract`);
    return;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = supSchema[keyword];
    if (!Array.isArray(branches)) continue;
    const { [keyword]: _branches, ...rest } = supSchema;
    const fits = branches.some((branch) => {
      const found: PathIssue[] = [];
      subsetIssues(subResolved, next(isObject(branch) ? { ...rest, ...branch } : branch, supResolved), path, mode, depth + 1, found);
      return found.length === 0;
    });
    if (!fits) add(issues, path, `does not match any allowed shape`);
    return;
  }
  if (Array.isArray(supSchema.allOf)) {
    const { allOf, ...rest } = supSchema;
    for (const part of allOf)
      subsetIssues(subResolved, next(isObject(part) ? { ...rest, ...part } : part, supResolved), path, mode, depth + 1, issues);
    return;
  }

  const subValues = valuesOf(subSchema);
  if (subValues) {
    for (const value of subValues) {
      const issue = valueIssue(value, supResolved, depth + 1);
      if (issue) add(issues, path, `${issue}`);
    }
    return;
  }
  if (valuesOf(supSchema)) {
    add(issues, path, `must be limited to the contract's allowed values`);
    return;
  }

  const supTypes = typeSet(supSchema);
  const subTypes = typeSet(subSchema);
  if (supTypes) {
    if (!subTypes) {
      add(issues, path, `must declare a type`);
      return;
    }
    const extra = [...subTypes].filter((type) => !typeAllows(supTypes, type));
    if (extra.length > 0) {
      add(issues, path, `allows ${extra.join(", ")} but the contract expects ${[...supTypes].join(", ")}`);
      return;
    }
  }
  const types = subTypes ?? new Set<string>();

  // Providers own their identifier and text formats; input checks compare shape, not string syntax.
  if (types.has("string") && mode === "data") {
    if (typeof supSchema.format === "string" && subSchema.format !== supSchema.format) {
      add(issues, path, `must use the ${supSchema.format} format`);
    }
    const formatCoversPattern = typeof supSchema.format === "string" && subSchema.format === supSchema.format;
    if (typeof supSchema.pattern === "string" && !formatCoversPattern && subSchema.pattern !== supSchema.pattern) {
      add(issues, path, `must use the contract pattern`);
    }
    if (!withinMin(subSchema.minLength, supSchema.minLength)) add(issues, path, `must be at least ${supSchema.minLength} characters`);
    if (!withinMax(subSchema.maxLength, supSchema.maxLength)) add(issues, path, `must be at most ${supSchema.maxLength} characters`);
  }
  if (types.has("number") || types.has("integer")) {
    if (!withinLower(lowerBound(subSchema), lowerBound(supSchema)) || !withinUpper(upperBound(subSchema), upperBound(supSchema))) {
      add(issues, path, `allows numbers outside the contract range`);
    }
  }
  if (types.has("array")) {
    if (!withinMin(subSchema.minItems, supSchema.minItems)) add(issues, path, `must contain at least ${supSchema.minItems} items`);
    if (!withinMax(subSchema.maxItems, supSchema.maxItems)) add(issues, path, `must contain at most ${supSchema.maxItems} items`);
    if (supSchema.items !== undefined) {
      subsetIssues(next(subSchema.items ?? true, subResolved), next(supSchema.items, supResolved), `${path}[]`, mode, depth + 1, issues);
    }
  }
  if (types.has("object")) objectIssues(subSchema, subResolved, supSchema, supResolved, path, mode, depth, issues);
};

const objectIssues = (
  subSchema: Json,
  sub: Side,
  supSchema: Json,
  sup: Side,
  path: string,
  mode: Mode,
  depth: number,
  issues: PathIssue[],
) => {
  const subProperties = isObject(subSchema.properties) ? subSchema.properties : {};
  const supProperties = isObject(supSchema.properties) ? supSchema.properties : {};
  const subRequired = new Set(Array.isArray(subSchema.required) ? subSchema.required : []);
  const supRequired = Array.isArray(supSchema.required) ? supSchema.required : [];
  const subAdditional = subSchema.additionalProperties ?? true;
  const supAdditional = supSchema.additionalProperties ?? true;
  const field = (name: string) => `${path}.${name}`;

  for (const name of supRequired) {
    if (typeof name === "string" && !subRequired.has(name)) {
      add(
        issues,
        field(name),
        `${mode === "data" ? "must always be returned" : "is required by the provider but optional in the contract"}`,
      );
    }
  }
  for (const [name, schema] of Object.entries(subProperties)) {
    if (name in supProperties) {
      subsetIssues({ schema, root: sub.root }, { schema: supProperties[name], root: sup.root }, field(name), mode, depth + 1, issues);
    } else if (supAdditional === false) {
      add(issues, field(name), `is not accepted`);
    } else {
      subsetIssues({ schema, root: sub.root }, { schema: supAdditional, root: sup.root }, field(name), mode, depth + 1, issues);
    }
  }
  if (subAdditional === false) return;
  for (const [name, schema] of Object.entries(supProperties)) {
    if (!(name in subProperties)) {
      subsetIssues({ schema: subAdditional, root: sub.root }, { schema, root: sup.root }, field(name), mode, depth + 1, issues);
    }
  }
  if (supAdditional === false) add(issues, path, `must not allow undeclared properties`);
  else
    subsetIssues(
      { schema: subAdditional, root: sub.root },
      { schema: supAdditional, root: sup.root },
      `${path}.*`,
      mode,
      depth + 1,
      issues,
    );
};

const schemaIssues = (sub: Json, sup: Json, mode: Mode): PathIssue[] => {
  const issues: PathIssue[] = [];
  subsetIssues({ schema: sub, root: sub }, { schema: sup, root: sup }, "$", mode, 0, issues);
  return issues;
};

/**
 * Explains why a published capability cannot serve a consumer contract.
 * An empty list means every contract input is accepted by the provider and
 * every result the provider may return satisfies the contract data schema.
 * Input checks compare shape, required fields, values, and numeric bounds;
 * string syntax such as identifier patterns stays with the provider.
 */
export const capabilityContractIssues = (
  contract: CapabilityContract,
  candidate: CapabilityContractCandidate,
): CapabilityContractIssue[] => {
  if (candidate.kind !== contract.kind) {
    return [{ code: "kind", path: "$", message: `Expected ${contract.kind === "query" ? "a Query" : "an Action"}` }];
  }
  const issues: CapabilityContractIssue[] = [];
  if (candidate.operation.stream) issues.push({ code: "stream", path: "$", message: "Streaming capabilities are not supported" });
  if (contract.idempotency === "required" && candidate.kind === "action" && candidate.operation.idempotency !== "required") {
    issues.push({ code: "idempotency", path: "$", message: "The Action must require an idempotency key" });
  }
  const contractInput = z.toJSONSchema(contract.input, { io: "input" }) as Json;
  const contractData = z.toJSONSchema(contract.data, { io: "output" }) as Json;
  for (const issue of schemaIssues(contractInput, candidate.operation.inputSchema, "input")) issues.push({ code: "input", ...issue });
  for (const issue of schemaIssues(candidate.operation.dataSchema, contractData, "data")) issues.push({ code: "data", ...issue });
  return issues;
};
