import { createHash } from "node:crypto";
import { isServiceError, type Result, type ServiceError } from "@k2b/stdlib";
import { z } from "zod";
import {
  CAPABILITY_ERROR_STATUSES,
  CAPABILITY_FRAMEWORK_ERROR_CODES,
  CAPABILITY_MAX_RESULT_BYTES,
  CAPABILITY_PROTOCOL_VERSION,
  type CapabilityActionDefinition,
  type CapabilityActionManifest,
  type CapabilityActionReviewResult,
  CapabilityActionReviewSchema,
  type CapabilityActionSentences,
  type CapabilityCommandDefinition,
  type CapabilityCommandManifest,
  CapabilityCommandManifestSchema,
  type CapabilityDefinitions,
  type CapabilityError,
  CapabilityErrorSchema,
  type CapabilityExecutionContext,
  type CapabilityFileProviderDeclaration,
  CapabilityIdempotencyKeySchema,
  type CapabilityInvocationResult,
  CapabilityLocalIdSchema,
  type CapabilityManifest,
  CapabilityManifestSchema,
  type CapabilityOperationPresentationTranslation,
  type CapabilityPresentationCatalog,
  type CapabilityPresentationTranslation,
  type CapabilityQueryDefinition,
  type CapabilityQueryManifest,
  type CapabilityResourceTypeDefinition,
  type CapabilitySearchTagDefinition,
  type CapabilityStreamDefinition,
  type CapabilityUniversalSearchDefinition,
  capabilityResultSchema,
  UniversalSearchDataSchema,
  UniversalSearchInputSchema,
} from "../contracts/capabilities";
import { fileProviderIssues } from "../contracts/file-provider";
import { canonicalLocale, localeFallbackChain, normalizeLocale } from "../shared/locale";
import {
  CAPABILITY_SENTENCE_KEYS,
  CAPABILITY_SENTENCE_MAX_CHARS,
  type CapabilityActionWording,
  capabilitySentenceFields,
  parseCapabilitySentence,
  resolveCapabilityActionSentences,
} from "./capability-sentences";

type JsonSchema = Record<string, unknown>;
const MAX_CAPABILITY_MANIFEST_BYTES = 256 * 1024;

/**
 * The producer side of the shared manifest shape: an app registers exactly the fields and entries its
 * release defines. Readers use `CapabilityManifestSchema`, which ignores what a newer release added.
 */
const StrictCapabilityManifestSchema = CapabilityManifestSchema.out.strict();

/**
 * Every declaration field this release defines, per kind. The compiler rejects any other field instead
 * of dropping it: a declaration written for a newer release may restrict how an entry runs. Each list
 * is typed as the complete key set, so a new declaration field does not compile until it is listed.
 */
type DefinedFields<T> = Readonly<Record<keyof T, true>>;
const DECLARATION_FIELDS = {
  protocolVersion: true,
  presentation: true,
  types: true,
  queries: true,
  actions: true,
  commands: true,
  fileProvider: true,
} satisfies DefinedFields<CapabilityDefinitions>;
const FILE_PROVIDER_FIELDS = { list: true, read: true, save: true } satisfies DefinedFields<CapabilityFileProviderDeclaration>;
const TYPE_FIELDS = { title: true, description: true, icon: true, reader: true } satisfies DefinedFields<CapabilityResourceTypeDefinition>;
const QUERY_FIELDS = {
  title: true,
  description: true,
  input: true,
  data: true,
  openWorld: true,
  stream: true,
  universalSearch: true,
  run: true,
} satisfies DefinedFields<CapabilityQueryDefinition>;
const ACTION_FIELDS = {
  title: true,
  description: true,
  input: true,
  data: true,
  destructive: true,
  openWorld: true,
  stream: true,
  idempotency: true,
  approval: true,
  review: true,
  run: true,
} satisfies DefinedFields<CapabilityActionDefinition>;
const COMMAND_FIELDS = {
  title: true,
  description: true,
  icon: true,
  keywords: true,
  input: true,
  path: true,
} satisfies DefinedFields<CapabilityCommandDefinition>;
const UNIVERSAL_SEARCH_FIELDS = { tags: true, scopeTypes: true } satisfies DefinedFields<CapabilityUniversalSearchDefinition>;
const SEARCH_TAG_FIELDS = {
  tag: true,
  title: true,
  description: true,
  aliases: true,
} satisfies DefinedFields<CapabilitySearchTagDefinition>;
const READ_STREAM_FIELDS = { direction: true, maxBytes: true, read: true } satisfies DefinedFields<
  Extract<CapabilityStreamDefinition, { direction: "read" }>
>;
const WRITE_STREAM_FIELDS = { direction: true, maxBytes: true, write: true, status: true, abort: true } satisfies DefinedFields<
  Extract<CapabilityStreamDefinition, { direction: "write" }>
>;

const assertDefinedFields = (definition: object, fields: object, label: string): void => {
  const field = Object.keys(definition).find((key) => !Object.hasOwn(fields, key));
  if (field) throw new Error(`${label} contains unsupported field "${field}"`);
};

const assertDefinedStreamFields = (stream: CapabilityStreamDefinition | undefined, label: string): void => {
  if (stream) assertDefinedFields(stream, stream.direction === "write" ? WRITE_STREAM_FIELDS : READ_STREAM_FIELDS, `${label} stream`);
};

export type CompiledCapabilityQuery = {
  definition: CapabilityQueryDefinition;
  manifest: CapabilityQueryManifest;
  resultSchema: z.ZodType;
};

export type CompiledCapabilityAction = {
  definition: CapabilityActionDefinition;
  manifest: CapabilityActionManifest;
  resultSchema: z.ZodType;
};

export type CompiledCapabilities = {
  manifest: CapabilityManifest;
  presentation?: CapabilityPresentationCatalog;
  typeIds: ReadonlySet<string>;
  queries: ReadonlyMap<string, CompiledCapabilityQuery>;
  actions: ReadonlyMap<string, CompiledCapabilityAction>;
};

type CapabilityProviderResult = CapabilityInvocationResult<unknown> | CapabilityActionReviewResult;
type CapabilityProviderFailure = { ok: false; error: CapabilityError };
const capabilityProviderErrorStatuses = new Set<number>(CAPABILITY_ERROR_STATUSES);

const isCapabilityProviderErrorStatus = (value: unknown): value is CapabilityError["status"] =>
  typeof value === "number" && capabilityProviderErrorStatuses.has(value);

const invalidProviderError = (message: string): CapabilityProviderFailure => ({
  ok: false,
  error: {
    code: CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse,
    message,
    status: 500,
  },
});

const normalizeProviderError = (value: unknown, message: string, onInvalid?: (error: unknown) => void): CapabilityProviderFailure => {
  const error = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const parsed = CapabilityErrorSchema.safeParse({ code: error.code, message: error.message, details: error.details });
  if (parsed.success && isCapabilityProviderErrorStatus(error.status)) {
    return { ok: false, error: { ...parsed.data, status: error.status } };
  }
  try {
    onInvalid?.(new Error(message));
  } catch {
    // Observability must not change the public failure contract.
  }
  return invalidProviderError(message);
};

const providerPayload = (code: string, message: string, details?: Record<string, unknown>): Record<string, unknown> => ({
  code,
  message,
  ...(details ? { details } : {}),
});

/** Serializes one framework-owned provider response exactly once and enforces the public byte bound. */
export const serializeCapabilityProviderResult = (
  result: CapabilityProviderResult,
  options: { nonIdempotentAction?: boolean } = {},
): { body: string; status: number } => {
  if (options.nonIdempotentAction && !result.ok && result.error.code === CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse) {
    const unknown = providerPayload(
      CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown,
      "The Action result could not be validated and its outcome is unknown; do not retry automatically",
      { retrySafe: false },
    );
    return { body: JSON.stringify(unknown), status: 502 };
  }
  const payload = result.ok ? result.data : providerPayload(result.error.code, result.error.message, result.error.details);
  try {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength <= CAPABILITY_MAX_RESULT_BYTES) {
      return { body, status: result.ok ? 200 : result.error.status };
    }
  } catch {
    // Fall through to the fixed bounded framework error below.
  }

  const fallback = options.nonIdempotentAction
    ? providerPayload(
        CAPABILITY_FRAMEWORK_ERROR_CODES.actionOutcomeUnknown,
        "The Action result could not be returned and its outcome is unknown; do not retry automatically",
        { retrySafe: false },
      )
    : providerPayload(
        CAPABILITY_FRAMEWORK_ERROR_CODES.responseTooLarge,
        "Capability response exceeds the shared size limit; narrow the request before retrying",
        { retrySafe: false },
      );
  return { body: JSON.stringify(fallback), status: options.nonIdempotentAction ? 502 : 500 };
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
};

export const capabilityHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(stableJsonValue(value)))
    .digest("hex");

const assertText = (value: string, label: string, max: number): void => {
  if (!value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} must be at most ${max} characters`);
};

const schemaFieldPaths = (schema: unknown, prefix = ""): Set<string> => {
  const paths = new Set<string>();
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return paths;
  const value = schema as Record<string, unknown>;
  const properties = value.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [field, definition] of Object.entries(properties)) {
      const path = prefix ? `${prefix}.${field}` : field;
      paths.add(path);
      for (const child of schemaFieldPaths(definition, path)) paths.add(child);
    }
  }
  if (value.items) {
    const arrayPrefix = `${prefix}[]`;
    for (const child of schemaFieldPaths(value.items, arrayPrefix)) paths.add(child);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(value[keyword])) continue;
    for (const entry of value[keyword]) {
      for (const child of schemaFieldPaths(entry, prefix)) paths.add(child);
    }
  }
  return paths;
};

const compileSchemaPresentation = (
  value: unknown,
  schema: Record<string, unknown>,
  label: string,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const paths = schemaFieldPaths(schema);
  const entries = Object.entries(value as Record<string, unknown>).map(([path, description]) => {
    if (!paths.has(path)) throw new Error(`${label} field path "${path}" does not exist in the projected schema`);
    if (typeof description !== "string") throw new Error(`${label}.${path} must be text`);
    assertText(description, `${label}.${path}`, 1000);
    return [path, description.trim()] as const;
  });
  return Object.fromEntries(entries);
};

const isAction = (
  operation: CapabilityQueryManifest | CapabilityActionManifest | CapabilityCommandManifest,
): operation is CapabilityActionManifest => "idempotency" in operation;

/**
 * Checks one Action's sentences against its schemas: every placeholder names a field the Action declares,
 * and only `done` reads result data, because the other sentences are shown before or instead of a result.
 */
export const compileActionSentences = (
  value: unknown,
  operation: Pick<CapabilityActionManifest, "inputSchema" | "dataSchema">,
  label: string,
  strict = true,
): CapabilityActionSentences => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const copy = value as Record<string, unknown>;
  const extra = Object.keys(copy).find((key) => !(CAPABILITY_SENTENCE_KEYS as readonly string[]).includes(key));
  if (strict && extra) throw new Error(`${label} contains unsupported field "${extra}"`);
  const paths = { input: schemaFieldPaths(operation.inputSchema), data: schemaFieldPaths(operation.dataSchema) };
  const sentences: Record<string, string> = {};
  for (const key of CAPABILITY_SENTENCE_KEYS) {
    const template = copy[key];
    if (template === undefined) continue;
    if (typeof template !== "string") throw new Error(`${label}.${key} must be text`);
    assertText(template, `${label}.${key}`, CAPABILITY_SENTENCE_MAX_CHARS);
    const parsed = parseCapabilitySentence(template.trim());
    if ("error" in parsed) throw new Error(`${label}.${key} ${parsed.error}`);
    for (const part of parsed.parts) {
      if (typeof part === "string") continue;
      if (part.source === "data" && key !== "done") throw new Error(`${label}.${key} may read {data.${part.path}} only in done`);
      if (!paths[part.source].has(part.path)) {
        throw new Error(`${label}.${key} placeholder {${part.source}.${part.path}} does not exist in the projected ${part.source} schema`);
      }
    }
    sentences[key] = template.trim();
  }
  if (Object.keys(sentences).length === 0) throw new Error(`${label} needs at least one sentence`);
  return sentences;
};

/** A reader keeps an entry's other copy when only its sentences come from a newer or broken producer. */
const readActionSentences = (value: unknown, operation: CapabilityActionManifest, label: string, strict: boolean) => {
  if (strict) return compileActionSentences(value, operation, label, strict);
  try {
    return compileActionSentences(value, operation, label, strict);
  } catch {
    return undefined;
  }
};

const compileOperationPresentation = (
  value: unknown,
  operation: CapabilityQueryManifest | CapabilityActionManifest | CapabilityCommandManifest,
  label: string,
  strict = true,
): CapabilityOperationPresentationTranslation => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const translation = value as Record<string, unknown>;
  const allowed = new Set(
    "path" in operation
      ? ["title", "description", "input"]
      : ["title", "description", "input", "data", "searchTags", ...(isAction(operation) ? ["sentences"] : [])],
  );
  const extra = Object.keys(translation).find((key) => !allowed.has(key));
  if (strict && extra) throw new Error(`${label} contains unsupported field "${extra}"`);
  if (translation.title !== undefined) {
    if (typeof translation.title !== "string") throw new Error(`${label}.title must be text`);
    assertText(translation.title, `${label}.title`, 120);
  }
  if (translation.description !== undefined) {
    if (typeof translation.description !== "string") throw new Error(`${label}.description must be text`);
    assertText(translation.description, `${label}.description`, 1000);
  }
  let searchTags: CapabilityOperationPresentationTranslation["searchTags"];
  const universalSearch = "universalSearch" in operation ? operation.universalSearch : undefined;
  // A reader skips search-tag copy for an operation without Universal Search instead of losing its other copy.
  if (translation.searchTags !== undefined && (strict || universalSearch)) {
    if (!universalSearch) throw new Error(`${label}.searchTags requires Universal Search`);
    if (!translation.searchTags || typeof translation.searchTags !== "object" || Array.isArray(translation.searchTags)) {
      throw new Error(`${label}.searchTags must be an object`);
    }
    const tags = new Map(universalSearch.tags.map((tag) => [tag.tag, tag]));
    searchTags = Object.fromEntries(
      Object.entries(translation.searchTags as Record<string, unknown>).map(([tag, presentation]) => {
        if (!tags.has(tag)) throw new Error(`${label}.searchTags references unknown stable tag "${tag}"`);
        if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) {
          throw new Error(`${label}.searchTags.${tag} must be an object`);
        }
        const copy = presentation as Record<string, unknown>;
        const extraField = Object.keys(copy).find((key) => key !== "title" && key !== "description");
        if (strict && extraField) throw new Error(`${label}.searchTags.${tag} contains unsupported field "${extraField}"`);
        if (copy.title !== undefined) {
          if (typeof copy.title !== "string") throw new Error(`${label}.searchTags.${tag}.title must be text`);
          assertText(copy.title, `${label}.searchTags.${tag}.title`, 120);
        }
        if (copy.description !== undefined) {
          if (typeof copy.description !== "string") throw new Error(`${label}.searchTags.${tag}.description must be text`);
          assertText(copy.description, `${label}.searchTags.${tag}.description`, 500);
        }
        return [
          tag,
          { ...(copy.title ? { title: copy.title.trim() } : {}), ...(copy.description ? { description: copy.description.trim() } : {}) },
        ];
      }),
    );
  }
  const input = compileSchemaPresentation(translation.input, operation.inputSchema, `${label}.input`);
  const data = "dataSchema" in operation ? compileSchemaPresentation(translation.data, operation.dataSchema, `${label}.data`) : undefined;
  const sentences =
    translation.sentences !== undefined && isAction(operation)
      ? readActionSentences(translation.sentences, operation, `${label}.sentences`, strict)
      : undefined;
  return {
    ...(typeof translation.title === "string" ? { title: translation.title.trim() } : {}),
    ...(typeof translation.description === "string" ? { description: translation.description.trim() } : {}),
    ...(input ? { input } : {}),
    ...(data ? { data } : {}),
    ...(searchTags ? { searchTags } : {}),
    ...(sentences ? { sentences } : {}),
  };
};

/**
 * Compiles human presentation for one manifest. A producer must declare exactly what its release
 * supports. A reader of a registered manifest ignores fields from a newer release and skips the
 * entry translations it cannot apply, such as those of left-out entries; presentation never grants access.
 */
export const compileCapabilityPresentation = (
  manifest: CapabilityManifest,
  value: unknown,
  mode: "producer" | "reader" = "producer",
): CapabilityPresentationCatalog | undefined => {
  const strict = mode === "producer";
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Capability presentation must be an object");
  const catalog = value as Record<string, unknown>;
  if (strict && Object.keys(catalog).some((key) => key !== "baseLocale" && key !== "sentences" && key !== "translations")) {
    throw new Error("Capability presentation contains unsupported fields");
  }
  const baseLocale = typeof catalog.baseLocale === "string" ? canonicalLocale(catalog.baseLocale) : undefined;
  if (!baseLocale) throw new Error("Capability presentation baseLocale must be a valid BCP 47 locale");
  if (!catalog.translations || typeof catalog.translations !== "object" || Array.isArray(catalog.translations)) {
    throw new Error("Capability presentation translations must be an object");
  }
  const types = new Map(manifest.types.map((type) => [type.localId, type]));
  const queries = new Map(manifest.queries.map((operation) => [operation.localId, operation]));
  const actions = new Map(manifest.actions.map((operation) => [operation.localId, operation]));
  const commands = new Map(manifest.commands.map((operation) => [operation.localId, operation]));
  let sentences: Record<string, CapabilityActionSentences> | undefined;
  if (catalog.sentences !== undefined) {
    if (!catalog.sentences || typeof catalog.sentences !== "object" || Array.isArray(catalog.sentences)) {
      throw new Error("Capability presentation sentences must be an object");
    }
    sentences = Object.fromEntries(
      Object.entries(catalog.sentences as Record<string, unknown>).flatMap(([localId, entry]) => {
        const action = actions.get(localId);
        if (!action) {
          if (strict) throw new Error(`Action sentences reference unknown localId "${localId}"`);
          return [];
        }
        const compiled = readActionSentences(entry, action, `Action ${localId}.sentences`, strict);
        return compiled ? [[localId, compiled]] : [];
      }),
    );
  }
  const translations: Record<string, CapabilityPresentationTranslation> = {};
  for (const [locale, rawTranslation] of Object.entries(catalog.translations as Record<string, unknown>)) {
    const canonical = canonicalLocale(locale);
    if (!canonical) throw new Error(`Capability presentation locale "${locale}" is invalid`);
    if (canonical === baseLocale) throw new Error(`Capability presentation translations must not repeat base locale ${baseLocale}`);
    if (translations[canonical]) throw new Error(`Capability presentation locale "${locale}" duplicates ${canonical}`);
    if (!rawTranslation || typeof rawTranslation !== "object" || Array.isArray(rawTranslation)) {
      throw new Error(`Capability presentation translation ${canonical} must be an object`);
    }
    const raw = rawTranslation as Record<string, unknown>;
    const extra = Object.keys(raw).find((key) => key !== "types" && key !== "queries" && key !== "actions" && key !== "commands");
    if (strict && extra) throw new Error(`Capability presentation translation ${canonical} contains unsupported field "${extra}"`);
    const compileGroup = <T>(
      group: unknown,
      definitions: ReadonlyMap<string, T>,
      kind: string,
      compile: (entry: unknown, definition: T, label: string) => unknown,
    ): Readonly<Record<string, never>> | undefined => {
      if (group === undefined) return undefined;
      if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error(`${kind} translations must be an object`);
      return Object.fromEntries(
        Object.entries(group as Record<string, unknown>).flatMap(([localId, entry]) => {
          const definition = definitions.get(localId);
          if (!definition) {
            if (strict) throw new Error(`${kind} translation references unknown localId "${localId}"`);
            return [];
          }
          try {
            return [[localId, compile(entry, definition, `${kind} ${localId}`)]];
          } catch (error) {
            if (strict) throw error;
            return [];
          }
        }),
      ) as Readonly<Record<string, never>>;
    };
    const translatedTypes = compileGroup(raw.types, types, "Resource type", (entry, _definition, label) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} must be an object`);
      const copy = entry as Record<string, unknown>;
      const extraField = Object.keys(copy).find((key) => key !== "title" && key !== "description");
      if (strict && extraField) throw new Error(`${label} contains unsupported field "${extraField}"`);
      if (copy.title !== undefined) {
        if (typeof copy.title !== "string") throw new Error(`${label}.title must be text`);
        assertText(copy.title, `${label}.title`, 120);
      }
      if (copy.description !== undefined) {
        if (typeof copy.description !== "string") throw new Error(`${label}.description must be text`);
        assertText(copy.description, `${label}.description`, 500);
      }
      return {
        ...(copy.title ? { title: String(copy.title).trim() } : {}),
        ...(copy.description ? { description: String(copy.description).trim() } : {}),
      };
    });
    const operationPresentation = (entry: unknown, operation: Parameters<typeof compileOperationPresentation>[1], label: string) =>
      compileOperationPresentation(entry, operation, label, strict);
    const translatedQueries = compileGroup(raw.queries, queries, "Query", operationPresentation);
    const translatedActions = compileGroup(raw.actions, actions, "Action", operationPresentation);
    const translatedCommands = compileGroup(raw.commands, commands, "Command", operationPresentation);
    translations[canonical] = {
      ...(translatedTypes ? { types: translatedTypes } : {}),
      ...(translatedQueries ? { queries: translatedQueries } : {}),
      ...(translatedActions ? { actions: translatedActions } : {}),
      ...(translatedCommands ? { commands: translatedCommands } : {}),
    };
  }
  return { baseLocale, ...(sentences && Object.keys(sentences).length > 0 ? { sentences } : {}), translations };
};

const projectSchema = (schema: z.ZodType, label: string, io: "input" | "output"): JsonSchema => {
  try {
    const projected = z.toJSONSchema(schema, { io }) as JsonSchema;
    z.fromJSONSchema(projected);
    return projected;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not JSON-Schema-round-trippable: ${message}`);
  }
};

const assertPropertyDescriptions = (schema: unknown, label: string, path: readonly string[] = []): void => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const value = schema as Record<string, unknown>;
  const properties = value.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [field, definition] of Object.entries(properties)) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
      const property = definition as Record<string, unknown>;
      if (typeof property.description !== "string" || !property.description.trim()) {
        throw new Error(`${label}.${[...path, field].join(".")} needs a concise Zod description`);
      }
      assertPropertyDescriptions(property, label, [...path, field]);
    }
  }
  if (value.items) assertPropertyDescriptions(value.items, label, [...path, "[]"]);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (!Array.isArray(value[keyword])) continue;
    value[keyword].forEach((entry, index) => assertPropertyDescriptions(entry, label, [...path, `${keyword}[${index}]`]));
  }
  const definitions = value.$defs;
  if (definitions && typeof definitions === "object" && !Array.isArray(definitions)) {
    for (const [name, definition] of Object.entries(definitions)) {
      assertPropertyDescriptions(definition, label, [...path, `$defs.${name}`]);
    }
  }
};

const assertCanonicalReaderInput = (schema: JsonSchema, label: string): void => {
  const properties = schema.properties;
  const id = properties && typeof properties === "object" && !Array.isArray(properties) ? (properties as JsonSchema).id : undefined;
  if (!id || typeof id !== "object" || Array.isArray(id) || (id as JsonSchema).type !== "string") {
    throw new Error(`${label} must require a string id field`);
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
  if (!required.includes("id")) throw new Error(`${label} must require a string id field`);
  const additionalRequired = required.filter((field) => field !== "id");
  if (additionalRequired.length > 0) {
    throw new Error(`${label} cannot require fields other than id: ${additionalRequired.join(", ")}`);
  }
};

const assertClosedObjectInput = (schema: JsonSchema, label: string): void => {
  if (schema.type !== "object") throw new Error(`${label} must be a Zod object schema`);
  if (schema.additionalProperties !== false) throw new Error(`${label} must reject unknown properties`);
  assertPropertyDescriptions(schema, label);
};

const qualifiedId = (appId: string, localId: string): string => `${appId}.${localId}`;

const assertLocalId = (localId: string, label: string): void => {
  const parsed = CapabilityLocalIdSchema.safeParse(localId);
  if (!parsed.success) throw new Error(`${label} key "${localId}" is invalid: ${parsed.error.issues[0]?.message ?? "invalid id"}`);
};

const normalizeSearchTags = (definition: CapabilityQueryDefinition, label: string) => {
  if (!definition.universalSearch) return undefined;
  assertDefinedFields(definition.universalSearch, UNIVERSAL_SEARCH_FIELDS, `${label} universalSearch`);
  const seen = new Set<string>();
  const tags = definition.universalSearch.tags.map((tag) => {
    assertDefinedFields(tag, SEARCH_TAG_FIELDS, `${label} search tag ${tag.tag}`);
    assertText(tag.tag, `${label} search tag`, 64);
    assertText(tag.title, `${label} search tag title`, 120);
    assertText(tag.description, `${label} search tag description`, 500);
    const canonical = tag.tag.trim().toLowerCase();
    const aliases = [...new Set((tag.aliases ?? []).map((alias) => alias.trim().toLowerCase()))].filter(Boolean);
    for (const value of [canonical, ...aliases]) {
      if (!/^[^\s#]+$/.test(value)) throw new Error(`${label} search tag "${value}" is invalid`);
      if (seen.has(value)) throw new Error(`${label} declares duplicate search tag or alias "${value}"`);
      seen.add(value);
    }
    return {
      tag: canonical,
      title: tag.title.trim(),
      description: tag.description.trim(),
      ...(aliases.length > 0 ? { aliases } : {}),
    };
  });
  return { tags, ...(definition.universalSearch.scopeTypes ? { scopeTypes: [...new Set(definition.universalSearch.scopeTypes)] } : {}) };
};

const compileOperationSchemas = (definition: CapabilityQueryDefinition | CapabilityActionDefinition, label: string) => {
  assertText(definition.title, `${label} title`, 120);
  assertText(definition.description, `${label} description`, 1000);
  const inputSchema = projectSchema(definition.input, `${label} input`, "input");
  assertClosedObjectInput(inputSchema, `${label} input`);
  if (
    "idempotency" in definition &&
    Object.hasOwn((inputSchema.properties as Record<string, unknown> | undefined) ?? {}, "idempotencyKey")
  ) {
    throw new Error(`${label} input field "idempotencyKey" is reserved for capability transports`);
  }
  const resultZodSchema = capabilityResultSchema(definition.data);
  const dataSchema = projectSchema(definition.data, `${label} data`, "output");
  return {
    inputSchema,
    dataSchema,
    resultZodSchema,
    schemaHash: capabilityHash({
      inputSchema,
      dataSchema,
      ...(definition.stream ? { stream: { direction: definition.stream.direction, maxBytes: definition.stream.maxBytes } } : {}),
    }),
  };
};

export const compileCapabilities = (appId: string, definitions: CapabilityDefinitions): CompiledCapabilities => {
  if (definitions.protocolVersion !== CAPABILITY_PROTOCOL_VERSION) {
    throw new Error(`Unsupported capability protocol version ${String(definitions.protocolVersion)}`);
  }
  assertDefinedFields(definitions, DECLARATION_FIELDS, "Capability declaration");
  if (definitions.fileProvider) assertDefinedFields(definitions.fileProvider, FILE_PROVIDER_FIELDS, "fileProvider");

  const localIds = new Set<string>();
  const registerLocalId = (localId: string, kind: string): void => {
    assertLocalId(localId, kind);
    if (localIds.has(localId)) throw new Error(`localId ${localId} is declared more than once across Types, Queries, and Actions`);
    localIds.add(localId);
  };

  const types = Object.entries(definitions.types ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([localId, definition]) => {
      registerLocalId(localId, "Resource type");
      assertDefinedFields(definition, TYPE_FIELDS, `Resource type ${localId}`);
      assertText(definition.title, `Resource type ${localId} title`, 120);
      assertText(definition.description, `Resource type ${localId} description`, 500);
      return {
        localId,
        title: definition.title.trim(),
        description: definition.description.trim(),
        ...(definition.icon ? { icon: definition.icon } : {}),
        ...(definition.reader !== undefined ? { reader: CapabilityLocalIdSchema.parse(definition.reader) } : {}),
      };
    });
  const typeIds = new Set(types.map((type) => qualifiedId(appId, type.localId)));

  const queries = new Map<string, CompiledCapabilityQuery>();
  for (const [localId, definition] of Object.entries(definitions.queries ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    registerLocalId(localId, "Query");
    const label = `Query ${localId}`;
    assertDefinedFields(definition, QUERY_FIELDS, label);
    assertDefinedStreamFields(definition.stream, label);
    if (
      definition.stream &&
      ((definition.stream.direction === "write" && !("idempotency" in definition)) || definition.stream.maxBytes <= 0)
    )
      throw new Error(`${label}: write streams require an Action and a positive byte budget`);
    if (definition.stream?.direction === "write" && "idempotency" in definition && definition.idempotency !== "required")
      throw new Error(`${label}: write streams require idempotency`);
    const schemas = compileOperationSchemas(definition, label);
    if (definition.universalSearch) {
      const expectedInput = projectSchema(UniversalSearchInputSchema, "Universal Search input", "input");
      const expectedData = projectSchema(UniversalSearchDataSchema, "Universal Search data", "output");
      if (capabilityHash(schemas.inputSchema) !== capabilityHash(expectedInput)) {
        throw new Error(`${label} exposed through Universal Search must use UniversalSearchInputSchema`);
      }
      if (capabilityHash(schemas.dataSchema) !== capabilityHash(expectedData)) {
        throw new Error(`${label} exposed through Universal Search must use UniversalSearchDataSchema`);
      }
    }
    const manifest = {
      localId,
      title: definition.title.trim(),
      description: definition.description.trim(),
      inputSchema: schemas.inputSchema,
      dataSchema: schemas.dataSchema,
      schemaHash: schemas.schemaHash,
      ...(definition.stream ? { stream: { direction: definition.stream.direction, maxBytes: definition.stream.maxBytes } } : {}),
      openWorld: definition.openWorld,
      universalSearch: normalizeSearchTags(definition, label),
    } satisfies CapabilityQueryManifest;
    for (const type of manifest.universalSearch?.scopeTypes ?? []) {
      if (!typeIds.has(qualifiedId(appId, type))) throw new Error(`${label} declares an unknown search scope type ${type}`);
    }
    queries.set(localId, {
      definition,
      manifest,
      resultSchema: schemas.resultZodSchema,
    });
  }
  for (const type of types) {
    if (!type.reader) continue;
    const reader = queries.get(type.reader);
    if (!reader) throw new Error(`Resource type ${type.localId} reader ${type.reader} must name an existing Query`);
    assertCanonicalReaderInput(reader.manifest.inputSchema, `Resource type ${type.localId} reader ${type.reader} input`);
  }
  const actions = new Map<string, CompiledCapabilityAction>();
  for (const [localId, definition] of Object.entries(definitions.actions ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    registerLocalId(localId, "Action");
    const label = `Action ${localId}`;
    assertDefinedFields(definition, ACTION_FIELDS, label);
    assertDefinedStreamFields(definition.stream, label);
    // Declaration rule, documented in docs/platform/capabilities.md:
    // destructive means irreversible or externally visible. An irreversible or
    // open-world effect must always be reviewable and safely repeatable, and
    // must never be approved once and then replayed silently.
    if (definition.destructive && !definition.review) {
      throw new Error(`${label} is destructive and must declare review()`);
    }
    if (definition.destructive && definition.idempotency !== "required") {
      throw new Error(`${label} is destructive and must declare idempotency: "required"`);
    }
    if (definition.openWorld && !definition.review) {
      throw new Error(`${label} is open-world and must declare review()`);
    }
    if (definition.openWorld && definition.idempotency !== "required") {
      throw new Error(`${label} is open-world and must declare idempotency: "required"`);
    }
    if (definition.approval === "rememberable" && definition.openWorld) {
      throw new Error(`${label} cannot remember approval for an open-world effect`);
    }
    if (definition.approval === "rememberable" && definition.destructive) {
      throw new Error(`${label} cannot remember approval for a destructive effect`);
    }
    if (definition.approval === "none" && (definition.destructive || definition.openWorld)) {
      throw new Error(`${label} cannot skip approval for destructive or open-world effects`);
    }
    if (definition.approval === "rememberable" && !definition.review) {
      throw new Error(`${label} must provide a review before approval can be remembered`);
    }
    if (
      definition.stream &&
      ((definition.stream.direction === "write" && !("idempotency" in definition)) || definition.stream.maxBytes <= 0)
    )
      throw new Error(`${label}: write streams require an Action and a positive byte budget`);
    if (definition.stream?.direction === "write" && "idempotency" in definition && definition.idempotency !== "required")
      throw new Error(`${label}: write streams require idempotency`);
    const schemas = compileOperationSchemas(definition, label);
    const manifest = {
      localId,
      title: definition.title.trim(),
      description: definition.description.trim(),
      inputSchema: schemas.inputSchema,
      dataSchema: schemas.dataSchema,
      schemaHash: schemas.schemaHash,
      ...(definition.stream ? { stream: { direction: definition.stream.direction, maxBytes: definition.stream.maxBytes } } : {}),
      destructive: definition.destructive,
      openWorld: definition.openWorld,
      idempotency: definition.idempotency,
      ...(definition.approval ? { approval: definition.approval } : {}),
      ...(definition.review ? { review: true as const } : {}),
    } satisfies CapabilityActionManifest;
    actions.set(localId, {
      definition,
      manifest,
      resultSchema: schemas.resultZodSchema,
    });
  }

  const commands = Object.entries(definitions.commands ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([localId, definition]) => {
      registerLocalId(localId, "Command");
      assertDefinedFields(definition, COMMAND_FIELDS, `Command ${localId}`);
      const inputSchema = projectSchema(definition.input, `Command ${localId} input`, "input");
      assertClosedObjectInput(inputSchema, `Command ${localId} input`);
      return CapabilityCommandManifestSchema.parse({
        localId,
        title: definition.title.trim(),
        description: definition.description.trim(),
        icon: definition.icon,
        keywords: [...(definition.keywords ?? [])],
        inputSchema,
        path: definition.path,
      });
    });

  const fileProvider = definitions.fileProvider;
  const manifestBase = {
    protocolVersion: CAPABILITY_PROTOCOL_VERSION,
    appId,
    types,
    queries: [...queries.values()].map((entry) => entry.manifest),
    actions: [...actions.values()].map((entry) => entry.manifest),
    commands,
    // Omitted when unused so manifests without a provider keep their earlier hash.
    ...(fileProvider
      ? { fileProvider: { list: fileProvider.list, read: fileProvider.read, ...(fileProvider.save ? { save: fileProvider.save } : {}) } }
      : {}),
  };
  const manifest = StrictCapabilityManifestSchema.parse({
    ...manifestBase,
    manifestHash: capabilityHash(manifestBase),
  });
  const providerIssues = fileProviderIssues(manifest);
  if (providerIssues.length > 0) {
    throw new Error(
      `fileProvider does not match the file-provider contract:\n- ${providerIssues
        .map((issue) => `${issue.function} (${issue.localId}) ${issue.path}: ${issue.message}`)
        .join("\n- ")}`,
    );
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest)).byteLength;
  if (manifestBytes > MAX_CAPABILITY_MANIFEST_BYTES) {
    throw new Error(`Capability manifest exceeds the ${MAX_CAPABILITY_MANIFEST_BYTES}-byte registry limit`);
  }
  const presentation = compileCapabilityPresentation(manifest, definitions.presentation);
  return { manifest, presentation, typeIds, queries, actions };
};

const applySchemaPresentation = (schema: Record<string, unknown>, descriptions: Readonly<Record<string, string>> | undefined) => {
  if (!descriptions || Object.keys(descriptions).length === 0) return schema;
  const localized = structuredClone(schema);
  const visit = (value: unknown, prefix = ""): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const properties = node.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [field, definition] of Object.entries(properties)) {
        const path = prefix ? `${prefix}.${field}` : field;
        if (definition && typeof definition === "object" && !Array.isArray(definition) && descriptions[path]) {
          (definition as Record<string, unknown>).description = descriptions[path];
        }
        visit(definition, path);
      }
    }
    if (node.items) visit(node.items, `${prefix}[]`);
    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(node[keyword])) node[keyword].forEach((entry) => visit(entry, prefix));
    }
  };
  visit(localized);
  return localized;
};

const presentationOverlays = (catalog: CapabilityPresentationCatalog, requestedLocale: string): CapabilityPresentationTranslation[] => {
  const byLocale = new Map(
    Object.entries(catalog.translations).flatMap(([locale, translation]) => {
      const canonical = canonicalLocale(locale);
      return canonical ? [[canonical, translation] as const] : [];
    }),
  );
  return localeFallbackChain(requestedLocale, normalizeLocale(catalog.baseLocale))
    .filter((locale) => locale !== normalizeLocale(catalog.baseLocale))
    .reverse()
    .flatMap((locale) => {
      const translation = byLocale.get(locale);
      return translation ? [translation] : [];
    });
};

/** The display title of one Query or Action in the requested locale, without rebuilding the manifest. */
export const resolveCapabilityOperationTitle = (
  operation: Pick<CapabilityQueryManifest, "localId" | "title">,
  group: "queries" | "actions",
  catalog: CapabilityPresentationCatalog | undefined,
  requestedLocale: string,
): string =>
  (catalog ? presentationOverlays(catalog, requestedLocale) : []).reduce(
    (title, translation) => translation[group]?.[operation.localId]?.title ?? title,
    operation.title,
  );

/**
 * Everything a reader needs to word calls of one Action in the requested locale: its title, the app's
 * sentences, and the labelled fields of the generic sentence. Derived only from the live manifest and
 * presentation catalog, the same way for every app.
 */
export const resolveCapabilityActionWording = (
  operation: CapabilityActionManifest,
  catalog: CapabilityPresentationCatalog | undefined,
  requestedLocale: string,
): CapabilityActionWording => {
  const overlays = catalog ? presentationOverlays(catalog, requestedLocale) : [];
  const inputDescriptions = Object.assign({}, ...overlays.map((translation) => translation.actions?.[operation.localId]?.input ?? {}));
  const sentences = resolveCapabilityActionSentences(operation.localId, catalog, requestedLocale);
  return {
    title: resolveCapabilityOperationTitle(operation, "actions", catalog, requestedLocale),
    ...(sentences ? { sentences } : {}),
    fields: capabilitySentenceFields({
      inputSchema: operation.inputSchema,
      dataSchema: operation.dataSchema,
      sentences,
      inputDescriptions,
    }),
  };
};

/** Resolve only human presentation; stable IDs, flags, tags, aliases, and data shapes stay untouched. */
export const resolveCapabilityManifestPresentation = (
  manifest: CapabilityManifest,
  catalog: CapabilityPresentationCatalog | undefined,
  requestedLocale: string,
): CapabilityManifest => {
  if (!catalog) return manifest;
  let current = manifest;
  for (const translation of presentationOverlays(catalog, requestedLocale)) {
    const manifestBase = {
      protocolVersion: current.protocolVersion,
      appId: current.appId,
      types: current.types.map((type) => {
        const copy = translation.types?.[type.localId];
        return copy ? { ...type, title: copy.title ?? type.title, description: copy.description ?? type.description } : type;
      }),
      queries: current.queries.map((operation) => {
        const copy = translation.queries?.[operation.localId];
        if (!copy) return operation;
        return {
          ...operation,
          title: copy.title ?? operation.title,
          description: copy.description ?? operation.description,
          inputSchema: applySchemaPresentation(operation.inputSchema, copy.input),
          dataSchema: applySchemaPresentation(operation.dataSchema, copy.data),
          ...(operation.universalSearch
            ? {
                universalSearch: {
                  ...operation.universalSearch,
                  tags: operation.universalSearch.tags.map((tag) => {
                    const tagCopy = copy.searchTags?.[tag.tag];
                    return tagCopy
                      ? { ...tag, title: tagCopy.title ?? tag.title, description: tagCopy.description ?? tag.description }
                      : tag;
                  }),
                },
              }
            : {}),
        };
      }),
      commands: current.commands.map((operation) => {
        const copy = translation.commands?.[operation.localId];
        return copy
          ? {
              ...operation,
              title: copy.title ?? operation.title,
              description: copy.description ?? operation.description,
              inputSchema: applySchemaPresentation(operation.inputSchema, copy.input),
            }
          : operation;
      }),
      actions: current.actions.map((operation) => {
        const copy = translation.actions?.[operation.localId];
        return copy
          ? {
              ...operation,
              title: copy.title ?? operation.title,
              description: copy.description ?? operation.description,
              inputSchema: applySchemaPresentation(operation.inputSchema, copy.input),
              dataSchema: applySchemaPresentation(operation.dataSchema, copy.data),
            }
          : operation;
      }),
      ...(current.fileProvider ? { fileProvider: current.fileProvider } : {}),
    };
    current = CapabilityManifestSchema.parse({ ...manifestBase, manifestHash: capabilityHash(manifestBase) });
  }
  return current;
};

const passes = (check: () => void): boolean => {
  try {
    check();
    return true;
  } catch {
    return false;
  }
};

/** Checks what the manifest schema cannot: that this release can call the operation as described. */
const assertUsableOperation = (operation: CapabilityQueryManifest | CapabilityActionManifest): void => {
  try {
    z.fromJSONSchema(structuredClone(operation.inputSchema));
    z.fromJSONSchema(structuredClone(operation.dataSchema));
  } catch (error) {
    throw new Error(
      `Operation ${operation.localId} contains unsupported JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertClosedObjectInput(operation.inputSchema, `Operation ${operation.localId} input`);
  if (operation.stream?.direction === "write" && (!("idempotency" in operation) || operation.idempotency !== "required")) {
    throw new Error(`Operation ${operation.localId} write streams require an idempotent Action`);
  }
  const expectedSchemaHash = capabilityHash({
    inputSchema: operation.inputSchema,
    dataSchema: operation.dataSchema,
    ...(operation.stream ? { stream: operation.stream } : {}),
  });
  if (operation.schemaHash !== expectedSchemaHash) throw new Error(`Operation ${operation.localId} schemaHash does not match its schemas`);
  if ("universalSearch" in operation && operation.universalSearch) {
    const expectedInput = projectSchema(UniversalSearchInputSchema, "Universal Search input", "input");
    const expectedData = projectSchema(UniversalSearchDataSchema, "Universal Search data", "output");
    if (
      capabilityHash(operation.inputSchema) !== capabilityHash(expectedInput) ||
      capabilityHash(operation.dataSchema) !== capabilityHash(expectedData)
    ) {
      throw new Error(`Operation ${operation.localId} advertises Universal Search with non-canonical schemas`);
    }
  }
};

const assertUsableCommand = (command: CapabilityCommandManifest): void => {
  z.fromJSONSchema(structuredClone(command.inputSchema));
  assertClosedObjectInput(command.inputSchema, `Command ${command.localId} input`);
};

/**
 * Validates an untrusted live manifest and recomputes every integrity hash.
 *
 * The manifest as a whole must be intact: the app id, unique local IDs, and the manifest hash. That
 * hash is checked against what the app sent, including everything ignored here, and stays the
 * manifest's identity: the app's registry summary still matches, so the app is not treated as changed
 * and a manifest without newer fields keeps its hash.
 *
 * Entries read like every reader reads them (`CapabilityManifestSchema`). An operation or Command this
 * release cannot use as described, for example because it cannot read its JSON Schema, is left out the
 * same way, together with what depends on it, and a Type whose reader Query does not take a single `id`
 * keeps no reader. The app's other entries stay available.
 */
export const parseCapabilityManifest = (value: unknown, expectedAppId: string): CapabilityManifest => {
  const sent = CapabilityManifestSchema.parse(value);
  if (sent.appId !== expectedAppId) throw new Error(`manifest appId must be ${expectedAppId}`);
  const localIds = new Set<string>();
  for (const { localId } of [...sent.types, ...sent.queries, ...sent.actions, ...sent.commands]) {
    if (localIds.has(localId)) throw new Error(`localId ${localId} is declared more than once across Types, Queries, and Actions`);
    localIds.add(localId);
  }
  // The schema accepted `value`, so it is an object; hash all of it, not only what this release read.
  const { manifestHash: _sentHash, ...sentBase } = value as Record<string, unknown>;
  if (sent.manifestHash !== capabilityHash(sentBase)) throw new Error("manifestHash does not match the manifest");

  // Reading the usable entries again leaves out what depends on an entry left out here.
  const manifest = CapabilityManifestSchema.parse({
    ...sent,
    queries: sent.queries.filter((query) => passes(() => assertUsableOperation(query))),
    actions: sent.actions.filter((action) => passes(() => assertUsableOperation(action))),
    commands: sent.commands.filter((command) => passes(() => assertUsableCommand(command))),
  });
  const queries = new Map(manifest.queries.map((query) => [query.localId, query]));
  return {
    ...manifest,
    types: manifest.types.map((type) => {
      const reader = type.reader === undefined ? undefined : queries.get(type.reader);
      if (!reader || passes(() => assertCanonicalReaderInput(reader.inputSchema, `Resource type ${type.localId} reader input`)))
        return type;
      const { reader: _unusable, ...withoutReader } = type;
      return withoutReader;
    }),
  };
};

const schemaSemantics = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(schemaSemantics);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "title" && key !== "description")
      .map(([key, entry]) => [key, schemaSemantics(entry)]),
  );
};

const sameSchema = (left: unknown, right: unknown): boolean =>
  JSON.stringify(stableJsonValue(schemaSemantics(left))) === JSON.stringify(stableJsonValue(schemaSemantics(right)));

const schemaEvolutionIssues = (previous: JsonSchema, next: JsonSchema, path: string, direction: "input" | "data"): string[] => {
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const previousBranches = previous[keyword];
    const nextBranches = next[keyword];
    if (!Array.isArray(previousBranches) || !Array.isArray(nextBranches)) continue;
    const previousRest = { ...previous };
    const nextRest = { ...next };
    delete previousRest[keyword];
    delete nextRest[keyword];
    if (!sameSchema(previousRest, nextRest) || previousBranches.length !== nextBranches.length) {
      return [`${path} changed`];
    }
    return previousBranches.flatMap((branch, index) =>
      schemaEvolutionIssues(branch as JsonSchema, nextBranches[index] as JsonSchema, `${path} ${keyword}[${index}]`, direction),
    );
  }
  if (previous.type === "array" && next.type === "array") {
    const previousRest = { ...previous };
    const nextRest = { ...next };
    const previousItems = previousRest.items;
    const nextItems = nextRest.items;
    delete previousRest.items;
    delete nextRest.items;
    const issues = sameSchema(previousRest, nextRest) ? [] : [`${path} constraints changed`];
    if (previousItems && nextItems) {
      issues.push(...schemaEvolutionIssues(previousItems as JsonSchema, nextItems as JsonSchema, `${path} items`, direction));
    } else if (!sameSchema(previousItems, nextItems)) {
      issues.push(`${path} items changed`);
    }
    return issues;
  }
  if (previous.type !== "object" || next.type !== "object") {
    return sameSchema(previous, next) ? [] : [`${path} changed`];
  }
  const issues: string[] = [];
  const previousRest = { ...previous };
  const nextRest = { ...next };
  delete previousRest.properties;
  delete previousRest.required;
  delete nextRest.properties;
  delete nextRest.required;
  if (!sameSchema(previousRest, nextRest)) issues.push(`${path} constraints changed`);

  const previousProperties = (previous.properties ?? {}) as Record<string, JsonSchema>;
  const nextProperties = (next.properties ?? {}) as Record<string, JsonSchema>;
  for (const [name, schema] of Object.entries(previousProperties)) {
    const nextSchema = nextProperties[name];
    if (!nextSchema) issues.push(`${path}.${name} was removed`);
    else issues.push(...schemaEvolutionIssues(schema, nextSchema, `${path}.${name}`, direction));
  }

  const previousRequired = new Set(Array.isArray(previous.required) ? (previous.required as string[]) : []);
  const nextRequired = new Set(Array.isArray(next.required) ? (next.required as string[]) : []);
  const invalidRequired =
    direction === "input"
      ? [...nextRequired].filter((name) => !previousRequired.has(name))
      : [...previousRequired].filter((name) => !nextRequired.has(name));
  for (const name of invalidRequired) {
    issues.push(direction === "input" ? `${path}.${name} became required` : `${path}.${name} is no longer guaranteed in results`);
  }
  return issues;
};

const searchTokens = (operation: CapabilityQueryManifest): Set<string> =>
  new Set(operation.universalSearch?.tags.flatMap((tag) => [tag.tag, ...(tag.aliases ?? [])]) ?? []);

/** Returns breaking same-id changes; additions and optional object fields are additive. */
export const capabilityManifestEvolutionIssues = (previous: CapabilityManifest, next: CapabilityManifest): string[] => {
  const issues: string[] = [];
  if (previous.appId !== next.appId) issues.push(`appId changed from ${previous.appId} to ${next.appId}`);
  if (previous.protocolVersion !== next.protocolVersion) issues.push("protocolVersion changed");

  const nextTypes = new Map(next.types.map((type) => [type.localId, type]));
  for (const type of previous.types) {
    const current = nextTypes.get(type.localId);
    if (!current) issues.push(`Type ${type.localId} was removed`);
    else if (type.reader && current.reader !== type.reader) issues.push(`Type ${type.localId} reader changed`);
  }

  const nextCommands = new Map(next.commands.map((command) => [command.localId, command]));
  for (const command of previous.commands) {
    const current = nextCommands.get(command.localId);
    if (!current) issues.push(`Command ${command.localId} was removed`);
    else issues.push(...schemaEvolutionIssues(command.inputSchema, current.inputSchema, `Command ${command.localId} input`, "input"));
  }
  const nextQueries = new Map(next.queries.map((operation) => [operation.localId, operation]));
  const nextActions = new Map(next.actions.map((operation) => [operation.localId, operation]));
  for (const operation of previous.queries) {
    const current = nextQueries.get(operation.localId);
    if (!current) {
      issues.push(
        nextActions.has(operation.localId) ? `Query ${operation.localId} changed kind` : `Query ${operation.localId} was removed`,
      );
      continue;
    }
    if (operation.openWorld !== current.openWorld) issues.push(`Query ${operation.localId} openWorld changed`);
    const currentSearchTokens = searchTokens(current);
    for (const token of searchTokens(operation)) {
      if (!currentSearchTokens.has(token)) issues.push(`Query ${operation.localId} removed Universal Search token ${token}`);
    }
    issues.push(...schemaEvolutionIssues(operation.inputSchema, current.inputSchema, `Query ${operation.localId} input`, "input"));
    issues.push(...schemaEvolutionIssues(operation.dataSchema, current.dataSchema, `Query ${operation.localId} data`, "data"));
  }
  for (const operation of previous.actions) {
    const current = nextActions.get(operation.localId);
    if (!current) {
      issues.push(
        nextQueries.has(operation.localId) ? `Action ${operation.localId} changed kind` : `Action ${operation.localId} was removed`,
      );
      continue;
    }
    if (operation.openWorld !== current.openWorld) issues.push(`Action ${operation.localId} openWorld changed`);
    if (operation.destructive !== current.destructive) issues.push(`Action ${operation.localId} destructive changed`);
    if (operation.idempotency !== current.idempotency) issues.push(`Action ${operation.localId} idempotency changed`);
    if (operation.review && !current.review) issues.push(`Action ${operation.localId} review was removed`);
    issues.push(...schemaEvolutionIssues(operation.inputSchema, current.inputSchema, `Action ${operation.localId} input`, "input"));
    issues.push(...schemaEvolutionIssues(operation.dataSchema, current.dataSchema, `Action ${operation.localId} data`, "data"));
  }
  return issues;
};

const resultRefs = (result: unknown): Array<{ type: string; id: string }> => {
  if (typeof result !== "object" || result === null) return [];
  const value = result as { refs?: unknown; data?: unknown };
  const refs = Array.isArray(value.refs) ? value.refs : [];
  const resources = UniversalSearchDataSchema.safeParse(value.data);
  if (!resources.success) return refs as Array<{ type: string; id: string }>;
  return [...(refs as Array<{ type: string; id: string }>), ...resources.data.map((entry) => entry.ref)] as Array<{
    type: string;
    id: string;
  }>;
};

export const validateCapabilityResult = (
  compiled: CompiledCapabilities,
  operation: CompiledCapabilityQuery | CompiledCapabilityAction,
  result: unknown,
  onInvalidResult?: (error: unknown) => void,
): Result<unknown, ServiceError> => {
  const parsed = operation.resultSchema.safeParse(result);
  if (!parsed.success) {
    try {
      onInvalidResult?.(
        new Error(
          `Capability ${operation.manifest.localId} returned data outside its registered schema: ${JSON.stringify(
            parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
          )}`,
        ),
      );
    } catch {
      // Observability must not change the public failure contract.
    }
    return {
      ok: false,
      error: {
        code: CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse,
        message: "Capability returned an invalid result",
        status: 500,
      },
    };
  }
  for (const ref of resultRefs(parsed.data)) {
    if (ref.type.startsWith(`${compiled.manifest.appId}.`) && !compiled.typeIds.has(ref.type)) {
      return {
        ok: false,
        error: {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse,
          message: `Capability returned undeclared resource type ${ref.type}`,
          status: 500,
        },
      };
    }
  }
  if ("universalSearch" in operation.manifest && operation.manifest.universalSearch) {
    const resources = UniversalSearchDataSchema.safeParse((parsed.data as { data?: unknown }).data);
    if (!resources.success || resources.data.some((resource) => !resource.links.some((link) => link.rel === "open"))) {
      return {
        ok: false,
        error: {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse,
          message: "Universal Search results must include an open link",
          status: 500,
        },
      };
    }
  }
  return { ok: true, data: parsed.data };
};

export const invokeCompiledCapability = async (params: {
  compiled: CompiledCapabilities;
  kind: "query" | "action";
  localId: string;
  input: unknown;
  expectedSchemaHash: string | null;
  context: CapabilityExecutionContext;
  onUnexpectedError?: (error: unknown) => void;
}): Promise<CapabilityInvocationResult<unknown>> => {
  const operation = params.kind === "query" ? params.compiled.queries.get(params.localId) : params.compiled.actions.get(params.localId);
  if (!operation) {
    return {
      ok: false,
      error: {
        code: CAPABILITY_FRAMEWORK_ERROR_CODES.capabilityNotFound,
        message: `Capability ${params.kind} not found`,
        status: 404,
      },
    };
  }
  if (params.expectedSchemaHash !== operation.manifest.schemaHash) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_MISMATCH",
        message: "Capability schema changed; refresh the live catalog and retry",
        status: 409,
        details: { expected: operation.manifest.schemaHash },
      },
    };
  }
  let context = params.context;
  if (params.kind === "action") {
    const action = operation as CompiledCapabilityAction;
    if (action.manifest.idempotency === "required" && !params.context.idempotencyKey) {
      return {
        ok: false,
        error: {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyRequired,
          message: "This action requires an Idempotency-Key",
          status: 400,
        },
      };
    }
    if (action.manifest.idempotency === "none" && params.context.idempotencyKey) {
      return {
        ok: false,
        error: {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyNotAllowed,
          message: "This Action does not support idempotent retries; omit Idempotency-Key",
          status: 400,
        },
      };
    }
  } else if (params.context.idempotencyKey) {
    return {
      ok: false,
      error: {
        code: CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyNotAllowed,
        message: "Idempotency-Key is only valid for Actions that require it",
        status: 400,
      },
    };
  }
  if (params.context.idempotencyKey) {
    const idempotencyKey = CapabilityIdempotencyKeySchema.safeParse(params.context.idempotencyKey);
    if (!idempotencyKey.success) {
      return {
        ok: false,
        error: {
          code: CAPABILITY_FRAMEWORK_ERROR_CODES.validationFailed,
          message: "Idempotency-Key is invalid",
          status: 400,
          details: { issues: idempotencyKey.error.issues },
        },
      };
    }
    context = { ...params.context, idempotencyKey: idempotencyKey.data };
  }
  const input = operation.definition.input.safeParse(params.input);
  if (!input.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Capability input is invalid",
        status: 400,
        details: { issues: input.error.issues },
      },
    };
  }
  if ("universalSearch" in operation.manifest && operation.manifest.universalSearch) {
    const search = UniversalSearchInputSchema.parse(input.data);
    if (
      search.scope &&
      !(operation.manifest.universalSearch.scopeTypes ?? []).some(
        (type) => qualifiedId(params.compiled.manifest.appId, type) === search.scope!.type,
      )
    )
      return { ok: false, error: { code: "VALIDATION_FAILED", message: "Unsupported search scope", status: 400 } };
  }
  try {
    const invoked = await operation.definition.run(input.data, context);
    if (!invoked.ok) {
      return normalizeProviderError(invoked.error, "Capability returned an invalid error", params.onUnexpectedError);
    }
    const stream = invoked.data.stream;
    if (
      stream &&
      (Buffer.byteLength(stream.id) > 2048 ||
        !operation.definition.stream ||
        stream.direction !== operation.definition.stream.direction ||
        stream.size > operation.definition.stream.maxBytes ||
        Date.parse(stream.expiresAt) <= Date.now() ||
        Date.parse(stream.expiresAt) > Date.now() + 86_400_000)
    )
      return invalidProviderError("Stream is outside its declared policy or 24 hour lifetime");
    const validated = validateCapabilityResult(params.compiled, operation, invoked.data, params.onUnexpectedError);
    return validated.ok
      ? ({
          ok: true,
          data: validated.data,
        } as CapabilityInvocationResult<unknown>)
      : { ok: false, error: validated.error };
  } catch (error) {
    if (isServiceError(error)) return normalizeProviderError(error, "Capability threw an invalid service error", params.onUnexpectedError);
    try {
      params.onUnexpectedError?.(error);
    } catch {
      // Observability must not change the public failure contract.
    }
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Capability execution failed",
        status: 500,
      },
    };
  }
};

export const reviewCompiledCapability = async (params: {
  compiled: CompiledCapabilities;
  localId: string;
  input: unknown;
  expectedSchemaHash: string | null;
  context: CapabilityExecutionContext;
  onUnexpectedError?: (error: unknown) => void;
}): Promise<CapabilityActionReviewResult> => {
  if (params.context.idempotencyKey) {
    return {
      ok: false,
      error: {
        code: CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyKeyNotAllowed,
        message: "Idempotency-Key is not valid for an Action review",
        status: 400,
      },
    };
  }
  const operation = params.compiled.actions.get(params.localId);
  if (!operation || !operation.definition.review) {
    return {
      ok: false,
      error: {
        code: CAPABILITY_FRAMEWORK_ERROR_CODES.capabilityNotFound,
        message: "Capability action review not found",
        status: 404,
      },
    };
  }
  if (params.expectedSchemaHash !== operation.manifest.schemaHash) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_MISMATCH",
        message: "Capability schema changed; refresh the live catalog and retry",
        status: 409,
        details: { expected: operation.manifest.schemaHash },
      },
    };
  }
  const input = operation.definition.input.safeParse(params.input);
  if (!input.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Capability input is invalid",
        status: 400,
        details: { issues: input.error.issues },
      },
    };
  }
  try {
    const reviewed = await operation.definition.review(input.data, params.context);
    if (!reviewed.ok) {
      return normalizeProviderError(reviewed.error, "Capability review returned an invalid error", params.onUnexpectedError);
    }
    const parsed = CapabilityActionReviewSchema.safeParse(reviewed.data);
    const approvalScopeIsValid =
      parsed.success &&
      (operation.manifest.approval === "rememberable" ? parsed.data.approvalScope !== undefined : parsed.data.approvalScope === undefined);
    if (!parsed.success || !approvalScopeIsValid) {
      try {
        params.onUnexpectedError?.(
          new Error(
            parsed.success
              ? `Capability ${operation.manifest.localId} review returned an approval scope inconsistent with its manifest`
              : `Capability ${operation.manifest.localId} review returned data outside its registered schema: ${JSON.stringify(
                  parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
                )}`,
          ),
        );
      } catch {
        // Observability must not change the public failure contract.
      }
    }
    return parsed.success && approvalScopeIsValid
      ? { ok: true, data: parsed.data }
      : {
          ok: false,
          error: {
            code: CAPABILITY_FRAMEWORK_ERROR_CODES.invalidAppResponse,
            message: "Capability review returned an invalid result",
            status: 500,
          },
        };
  } catch (error) {
    if (isServiceError(error))
      return normalizeProviderError(error, "Capability review threw an invalid service error", params.onUnexpectedError);
    try {
      params.onUnexpectedError?.(error);
    } catch {
      // Observability must not change the public failure contract.
    }
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: "Capability review failed",
        status: 500,
      },
    };
  }
};
