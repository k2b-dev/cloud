import { z } from "zod";
import type { AccessSubject, RequestActor, User } from "./shared";

export const CAPABILITY_PROTOCOL_VERSION = 1 as const;
export const CAPABILITY_MAX_REQUEST_BYTES = 256 * 1024;
export const CAPABILITY_MAX_RESULT_BYTES = 256 * 1024;
export const CAPABILITY_MAX_CATALOG_BYTES = 2 * 1024 * 1024;

export const CAPABILITY_FRAMEWORK_ERROR_CODES = {
  appUnavailable: "APP_UNAVAILABLE",
  capabilityNotFound: "CAPABILITY_NOT_FOUND",
  validationFailed: "VALIDATION_FAILED",
  schemaMismatch: "SCHEMA_MISMATCH",
  idempotencyKeyRequired: "IDEMPOTENCY_KEY_REQUIRED",
  idempotencyKeyNotAllowed: "IDEMPOTENCY_KEY_NOT_ALLOWED",
  idempotencyConflict: "IDEMPOTENCY_CONFLICT",
  deadlineExceeded: "DEADLINE_EXCEEDED",
  actionOutcomeUnknown: "ACTION_OUTCOME_UNKNOWN",
  requestCancelled: "REQUEST_CANCELLED",
  invalidAppResponse: "INVALID_APP_RESPONSE",
  responseTooLarge: "RESPONSE_TOO_LARGE",
  internal: "INTERNAL",
} as const;

export const capabilityIdempotencyConflict = (
  message: string,
  details?: Record<string, unknown>,
): CapabilityError & { code: "IDEMPOTENCY_CONFLICT"; status: 409 } => ({
  code: CAPABILITY_FRAMEWORK_ERROR_CODES.idempotencyConflict,
  message,
  status: 409,
  ...(details ? { details } : {}),
});

export const CapabilityIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "Idempotency keys must contain only visible ASCII characters");

const CAPABILITY_LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CAPABILITY_QUALIFIED_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CLOUD_PATH_PATTERN = /^\/(?![\\/])[^\\\u0000-\u001f\u007f]*$/;

export const CapabilityLocalIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(CAPABILITY_LOCAL_ID_PATTERN, "Use a stable lower-case capability id");

export const CapabilityQualifiedIdSchema = z
  .string()
  .min(3)
  .max(180)
  .regex(CAPABILITY_QUALIFIED_ID_PATTERN, "Expected a namespaced capability id such as contacts.contact");

export const CloudResourceRefSchema = z
  .object({
    type: CapabilityQualifiedIdSchema.describe("Namespaced resource type declared by the owning app."),
    id: z.string().min(1).max(512).describe("Stable app-owned resource identifier."),
  })
  .strict();

export type CloudResourceRef = z.infer<typeof CloudResourceRefSchema>;

export const CloudResourceReferenceSchema = CloudResourceRefSchema.extend({
  title: z.string().min(1).max(500).optional().describe("Optional current user-facing resource label."),
  preview: z.string().max(2000).optional().describe("Optional short plain-text context for the resource."),
  icon: z.string().min(1).max(120).optional().describe("Optional presentation icon for the resource."),
}).strict();

export type CloudResourceReference = z.infer<typeof CloudResourceReferenceSchema>;

export const CapabilitySemanticLinkSchema = z
  .object({
    rel: z.enum(["open", "edit", "status", "preview", "download"]).describe("Semantic relationship; clients decide how to present it."),
    href: z
      .string()
      .min(1)
      .max(2048)
      .regex(CLOUD_PATH_PATTERN, "Capability links must be root-relative same-origin Cloud paths")
      .describe("Root-relative Cloud URL."),
    title: z.string().min(1).max(120).optional().describe("Optional human-readable link label."),
  })
  .strict();

export type CapabilitySemanticLink = z.infer<typeof CapabilitySemanticLinkSchema>;

const CapabilityReviewDateTimeSchema = z.string().datetime({ offset: true });
const CapabilityReviewDateSchema = z.union([z.iso.date(), CapabilityReviewDateTimeSchema]);
const CapabilityActionReviewDetailSchema = z
  .object({
    label: z.string().min(1).max(120),
    value: z.string().max(10_000),
    display: z.enum(["inline", "block"]).optional(),
    format: z.enum(["date", "date-time"]).optional(),
  })
  .strict()
  .superRefine((detail, context) => {
    const schema =
      detail.format === "date" ? CapabilityReviewDateSchema : detail.format === "date-time" ? CapabilityReviewDateTimeSchema : null;
    if (schema?.safeParse(detail.value).success === false) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message:
          detail.format === "date" ? "Date review values must use YYYY-MM-DD or RFC 3339" : "Date-time review values must use RFC 3339",
      });
    }
  });

export const CapabilityActionReviewSchema = z
  .object({
    message: z.string().min(1).max(1000).describe("Plain-text description of the concrete Action consequence."),
    details: z.array(CapabilityActionReviewDetailSchema).max(20).optional(),
    links: z.array(CapabilitySemanticLinkSchema).max(10).optional(),
    approvalScope: z.string().min(1).max(200).optional().describe("Opaque app-owned scope for a rememberable Action approval."),
  })
  .strict();

export type CapabilityActionReview = z.infer<typeof CapabilityActionReviewSchema>;

export const CapabilityPageSchema = z.discriminatedUnion("hasMore", [
  z
    .object({
      hasMore: z.literal(true).describe("Another page is available."),
      nextCursor: z.string().min(1).max(2048).describe("Opaque cursor for the next page."),
    })
    .strict(),
  z
    .object({
      hasMore: z.literal(false).describe("This is the final page."),
    })
    .strict(),
]);

export type CapabilityPage = z.infer<typeof CapabilityPageSchema>;

export const capabilityPage = (nextCursor?: string | null): CapabilityPage =>
  nextCursor === undefined || nextCursor === null ? { hasMore: false } : { hasMore: true, nextCursor };

export type CapabilityResult<T> = {
  data: T;
  /** Provider-authored, user-facing summary of the successful result. Render as escaped plain text. */
  summary?: string;
  refs?: CloudResourceReference[];
  page?: CapabilityPage;
  links?: CapabilitySemanticLink[];
};

export const capabilityResultSchema = <T extends z.ZodType>(data: T): z.ZodType<CapabilityResult<z.output<T>>> =>
  z
    .object({
      data,
      summary: z.string().trim().min(1).max(500).optional(),
      refs: z.array(CloudResourceReferenceSchema).max(100).optional(),
      page: CapabilityPageSchema.optional(),
      links: z.array(CapabilitySemanticLinkSchema).max(20).optional(),
    })
    .strict() as unknown as z.ZodType<CapabilityResult<z.output<T>>>;

export const capabilityResultJsonSchema = (dataSchema: Record<string, unknown>): Record<string, unknown> =>
  z.toJSONSchema(capabilityResultSchema(z.fromJSONSchema(structuredClone(dataSchema))), { io: "output" }) as Record<string, unknown>;

export const CapabilityErrorSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CAPABILITY_ERROR_STATUSES = [400, 401, 403, 404, 409, 429, 499, 500, 502, 503, 504] as const;
export type CapabilityErrorStatus = (typeof CAPABILITY_ERROR_STATUSES)[number];
export type CapabilityError = {
  code: string;
  message: string;
  status: CapabilityErrorStatus;
  details?: Record<string, unknown>;
};
export type CapabilityInvocationResult<T> = { ok: true; data: CapabilityResult<T> } | { ok: false; error: CapabilityError };
export type CapabilityActionReviewResult = { ok: true; data: CapabilityActionReview } | { ok: false; error: CapabilityError };

export const CloudResourceViewSchema = z
  .object({
    ref: CloudResourceRefSchema.describe("Stable identity of the result."),
    title: z.string().min(1).max(500).describe("Primary result label."),
    preview: z.string().max(2000).optional().describe("Short plain-text result preview."),
    icon: z.string().min(1).max(120).optional().describe("Optional presentation icon."),
    priority: z.number().int().min(0).max(9).optional().describe("App-local relevance hint from zero to nine."),
    metadata: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120),
            value: z.string().max(1000),
          })
          .strict(),
      )
      .max(20)
      .optional()
      .describe("Small structured metadata shown with the result."),
    links: z.array(CapabilitySemanticLinkSchema).min(1).max(10).describe("Semantic links for the resource."),
  })
  .strict();

export type CloudResourceView = z.infer<typeof CloudResourceViewSchema>;

export const UniversalSearchInputSchema = z
  .object({
    query: z.string().max(500).describe("User-entered search text. Empty text is allowed when a facet narrows the query."),
    tags: z.array(z.string().min(1).max(64)).max(20).describe("Canonical search facets supported by this query."),
    limit: z.number().int().min(1).max(100).describe("Maximum number of results to return."),
  })
  .strict();

export type UniversalSearchInput = z.infer<typeof UniversalSearchInputSchema>;

export const UniversalSearchDataSchema = z.array(CloudResourceViewSchema).max(100);
export type UniversalSearchData = z.infer<typeof UniversalSearchDataSchema>;

export type CapabilityExecutionContext = {
  actor: RequestActor;
  accessSubject: AccessSubject;
  user: User | null;
  idempotencyKey?: string;
  /**
   * Canonical BCP 47 locale of the originating request, transported as
   * invocation metadata (never inside the input schema or auth token). Use it
   * for human-facing formatting or `@k2b/stdlib` message catalogs; stable
   * error codes and data must not depend on it.
   */
  locale: string;
  signal: AbortSignal;
};

export type CapabilityResourceTypeDefinition = {
  title: string;
  description: string;
  icon?: string;
  reader?: string;
};

export type CapabilitySearchTagDefinition = {
  tag: string;
  title: string;
  description: string;
  aliases?: readonly string[];
};

export type CapabilityUniversalSearchDefinition = {
  tags: readonly CapabilitySearchTagDefinition[];
};

export type CapabilitySchemaPresentation = Readonly<Record<string, string>>;

export type CapabilityOperationPresentationTranslation = {
  title?: string;
  description?: string;
  /** Human descriptions keyed by a stable dotted field path such as `filter.tags[]`. */
  input?: CapabilitySchemaPresentation;
  /** Human descriptions keyed by a stable dotted field path such as `items[].name`. */
  data?: CapabilitySchemaPresentation;
  /** Search-tag presentation keyed by the stable tag token. */
  searchTags?: Readonly<Record<string, { title?: string; description?: string }>>;
};

export type CapabilityPresentationTranslation = {
  types?: Readonly<Record<string, { title?: string; description?: string }>>;
  queries?: Readonly<Record<string, CapabilityOperationPresentationTranslation>>;
  actions?: Readonly<Record<string, CapabilityOperationPresentationTranslation>>;
};

export type CapabilityPresentationCatalog = {
  /** Locale of the complete Type, Query, Action, search-tag, and schema presentation. */
  baseLocale: string;
  /** Partial presentation overlays with exact -> ancestor -> base fallback. */
  translations: Readonly<Record<string, CapabilityPresentationTranslation>>;
};

export type CapabilityQueryDefinition<Input extends z.ZodType = z.ZodType<any>, Data extends z.ZodType = z.ZodType<any>> = {
  title: string;
  description: string;
  input: Input;
  data: Data;
  openWorld: boolean;
  universalSearch?: CapabilityUniversalSearchDefinition;
  run: (
    input: z.output<Input>,
    context: CapabilityExecutionContext,
  ) => CapabilityInvocationResult<z.output<Data>> | Promise<CapabilityInvocationResult<z.output<Data>>>;
};

export type CapabilityIdempotencyPolicy = "none" | "required";
export type CapabilityActionApprovalPolicy = "rememberable";

export type CapabilityActionDefinition<Input extends z.ZodType = z.ZodType<any>, Data extends z.ZodType = z.ZodType<any>> = {
  title: string;
  description: string;
  input: Input;
  data: Data;
  destructive: boolean;
  openWorld: boolean;
  idempotency: CapabilityIdempotencyPolicy;
  approval?: CapabilityActionApprovalPolicy;
  review?: (
    input: z.output<Input>,
    context: CapabilityExecutionContext,
  ) => CapabilityActionReviewResult | Promise<CapabilityActionReviewResult>;
  run: (
    input: z.output<Input>,
    context: CapabilityExecutionContext,
  ) => CapabilityInvocationResult<z.output<Data>> | Promise<CapabilityInvocationResult<z.output<Data>>>;
};

type CapabilityDefinitionCatalog<T> = Readonly<Record<string, T>>;

export type CapabilityDefinitions = {
  protocolVersion: typeof CAPABILITY_PROTOCOL_VERSION;
  presentation?: CapabilityPresentationCatalog;
  types?: CapabilityDefinitionCatalog<CapabilityResourceTypeDefinition>;
  queries?: CapabilityDefinitionCatalog<CapabilityQueryDefinition>;
  actions?: CapabilityDefinitionCatalog<CapabilityActionDefinition>;
};

/**
 * Declares one app's public capability surface. Runtime compilation happens
 * in defineApp.start(), where the app id is available for namespacing.
 */
export const defineCapabilities = <const T extends CapabilityDefinitions>(definitions: T): T => definitions;

export const CapabilityResourceTypeManifestSchema = z
  .object({
    localId: CapabilityLocalIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    icon: z.string().min(1).max(120).optional(),
    reader: CapabilityLocalIdSchema.optional(),
  })
  .strict();

export const CapabilitySearchTagManifestSchema = z
  .object({
    tag: z.string().min(1).max(64),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    aliases: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict();

const CapabilityOperationManifestBaseSchema = z
  .object({
    localId: CapabilityLocalIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    inputSchema: z.record(z.string(), z.unknown()),
    dataSchema: z.record(z.string(), z.unknown()),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const CapabilityQueryManifestSchema = CapabilityOperationManifestBaseSchema.extend({
  openWorld: z.boolean(),
  universalSearch: z
    .object({ tags: z.array(CapabilitySearchTagManifestSchema).max(100) })
    .strict()
    .optional(),
}).strict();

export const CapabilityActionManifestSchema = CapabilityOperationManifestBaseSchema.extend({
  destructive: z.boolean(),
  openWorld: z.boolean(),
  idempotency: z.enum(["none", "required"]),
  approval: z.literal("rememberable").optional(),
  review: z.literal(true).optional(),
}).strict();

export const CapabilityAppIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9-]*$/);

export const CapabilityManifestSchema = z
  .object({
    protocolVersion: z.literal(CAPABILITY_PROTOCOL_VERSION),
    appId: CapabilityAppIdSchema,
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    types: z.array(CapabilityResourceTypeManifestSchema).max(200),
    queries: z.array(CapabilityQueryManifestSchema).max(200),
    actions: z.array(CapabilityActionManifestSchema).max(200),
  })
  .strict();

export type CapabilityResourceTypeManifest = z.infer<typeof CapabilityResourceTypeManifestSchema>;
export type CapabilityQueryManifest = z.infer<typeof CapabilityQueryManifestSchema>;
export type CapabilityActionManifest = z.infer<typeof CapabilityActionManifestSchema>;
export type CapabilitySearchTagManifest = z.infer<typeof CapabilitySearchTagManifestSchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export const cloudResourceRefAppId = (ref: CloudResourceRef): string => ref.type.slice(0, ref.type.indexOf("."));

/** Resolves a resource reference against one current, validated app manifest. */
export const resolveCapabilityResourceReader = (manifest: CapabilityManifest, ref: CloudResourceRef): CapabilityQueryManifest | null => {
  if (cloudResourceRefAppId(ref) !== manifest.appId) return null;
  const prefix = `${manifest.appId}.`;
  const type = manifest.types.find((candidate) => candidate.localId === ref.type.slice(prefix.length));
  if (!type?.reader) return null;
  return manifest.queries.find((candidate) => candidate.localId === type.reader) ?? null;
};

export const CapabilityCatalogAppSchema = z
  .object({
    appId: CapabilityAppIdSchema,
    appName: z.string().min(1).max(200),
    appIcon: z.string().min(1).max(120),
    appDescription: z.string().max(1000),
    manifest: CapabilityManifestSchema,
  })
  .strict();

export const CapabilityCatalogSchema = z
  .object({
    protocolVersion: z.literal(CAPABILITY_PROTOCOL_VERSION),
    apps: z.array(CapabilityCatalogAppSchema).max(25),
    page: CapabilityPageSchema,
  })
  .strict();

export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
