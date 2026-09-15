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

export const SearchQuerySchema = z.object({
  q: z
    .string()
    .max(500)
    .optional()
    .default("")
    .transform((query) => query.trim()),
  tag: TagArraySchema.optional().default([]),
  app: z.string().trim().min(1).max(120).optional(),
  require_reader: z
    .enum(["true"])
    .optional()
    .transform((value) => value === "true"),
  provider_limit: z.coerce.number().int().min(1).max(30).optional().default(10),
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
});

export type SearchApp = z.infer<typeof SearchAppSchema>;
export type SearchItem = z.infer<typeof SearchItemSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
