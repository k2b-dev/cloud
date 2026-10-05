import { z } from "zod";
import { CloudResourceRefSchema } from "../../contracts";
import { CapabilitySearchTagManifestSchema } from "../../contracts/capabilities";

const TAG_PATTERN = /^[^\s#]+$/;
const SEARCH_BASE_URL = "https://cloud.invalid";

const isSameOriginPath = (value: string): boolean => {
  if (!value.startsWith("/")) return false;
  try {
    return new URL(value, SEARCH_BASE_URL).origin === SEARCH_BASE_URL;
  } catch {
    return false;
  }
};

const SameOriginPathSchema = z.string().refine(isSameOriginPath, {
  message: "Expected a root-relative same-origin path",
});

const TagArraySchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return [value];
    return [];
  },
  z
    .array(z.string().trim().min(1).max(64).regex(TAG_PATTERN))
    .max(20)
    .transform((tags) => [...new Set(tags.map((tag) => tag.toLowerCase()))]),
);

export const SearchQuerySchema = z
  .object({
    q: z
      .string()
      .max(500)
      .optional()
      .default("")
      .transform((query) => query.trim()),
    tag: TagArraySchema.optional().default([]),
    app: z.string().trim().min(1).max(120).optional(),
    scope_tag: z.string().trim().min(1).max(64).regex(TAG_PATTERN).toLowerCase().optional(),
    scope_type: CloudResourceRefSchema.shape.type.optional(),
    scope_id: CloudResourceRefSchema.shape.id.optional(),
    require_reader: z
      .enum(["true"])
      .optional()
      .transform((value) => value === "true"),
    provider_limit: z.coerce.number().int().min(1).max(30).optional().default(10),
  })
  .refine((value) => Boolean(value.scope_type) === Boolean(value.scope_id), { message: "Both scope_type and scope_id are required" })
  .refine((value) => !value.scope_tag || (Boolean(value.app) && !value.scope_type), {
    message: "A tag context requires an app and cannot include a resource scope",
  });

export const SearchAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  tags: z.array(CapabilitySearchTagManifestSchema).optional(),
});

export const SearchItemSchema = z.object({
  appId: z.string(),
  appName: z.string(),
  appIcon: z.string(),
  readable: z.boolean(),
  ref: CloudResourceRefSchema,
  title: z.string(),
  href: SameOriginPathSchema,
  preview: z.string().optional(),
  icon: z.string().optional(),
  priority: z.number().int().min(0).max(9).optional(),
  metadata: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  previewUrl: SameOriginPathSchema.optional(),
});

export const SearchResponseSchema = z.object({
  query: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(SearchItemSchema),
  apps: z.array(SearchAppSchema),
  unsupportedTags: z.array(z.string()).optional(),
  failedApps: z.array(z.string()).optional(),
});

/** Media type a client sends in `Accept` to receive one NDJSON line per app as soon as it finishes. */
export const SEARCH_STREAM_CONTENT_TYPE = "application/x-ndjson";

export const SearchProviderStatusSchema = z.enum(["ok", "empty", "timeout", "error"]);

/**
 * One line of a streamed search: `start` names the apps that search, one `provider` line follows per app in the
 * order the apps finish, and `done` closes the search. Apps without a line before `done` do not exist: every app
 * named in `start` gets exactly one line.
 */
export const SearchStreamLineSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    query: z.string(),
    apps: z.array(SearchAppSchema),
    providers: z.array(z.string()),
    unsupportedTags: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("provider"),
    provider: z.string(),
    status: SearchProviderStatusSchema,
    results: z.array(SearchItemSchema),
    ms: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("done"),
    status: z.enum(["complete", "partial"]),
    count: z.number().int().nonnegative(),
  }),
]);

export type SearchApp = z.infer<typeof SearchAppSchema>;
export type SearchItem = z.infer<typeof SearchItemSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type SearchProviderStatus = z.infer<typeof SearchProviderStatusSchema>;
export type SearchStreamLine = z.infer<typeof SearchStreamLineSchema>;
