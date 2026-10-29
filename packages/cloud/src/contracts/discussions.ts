import { z } from "zod";
import { type CapabilityManifest, CapabilitySemanticLinkSchema, CloudResourceRefSchema } from "./capabilities";
import { type CapabilityContractIssue, capabilityContractIssues } from "./capability-compatibility";
import { typeViewIssues } from "./resource-types";

/** Same page bound as resource lists and owner activity pages. */
export const DISCUSSION_PAGE_LIMIT = 100;
const cursor = z.string().min(1).max(2048).describe("Opaque continuation cursor.");
export const DiscussionContainersInputSchema = z
  .object({
    query: z.string().max(500).optional().describe("Optional container search text."),
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(DISCUSSION_PAGE_LIMIT).default(50).describe("Maximum containers in this page."),
  })
  .strict();
export const DiscussionContainerSchema = z
  .object({
    ref: CloudResourceRefSchema,
    title: z.string().min(1).max(500),
  })
  .strict();
export const DiscussionContainersDataSchema = z
  .object({
    items: z.array(DiscussionContainerSchema).max(DISCUSSION_PAGE_LIMIT),
    next: cursor.nullable(),
  })
  .strict();

/** Shared owner activity, independent of the application or discussion consumer. */
export const ResourceActivityEventSchema = z
  .object({
    id: z.string().max(100),
    at: z.string().datetime({ offset: true }),
    ref: CloudResourceRefSchema.nullable(),
    title: z.string().max(500).nullable().optional(),
    actor: z.object({ type: z.enum(["user", "service_account", "system"]), id: z.uuid().nullable(), name: z.string().max(1000) }).strict(),
    icon: z
      .string()
      .regex(/^ti ti-[a-z0-9-]+$/)
      .max(80),
    sentence: z.string().max(4000),
    href: CapabilitySemanticLinkSchema.shape.href.optional(),
    count: z.number().int().min(1),
  })
  .strict();
export type ResourceActivityEvent = z.infer<typeof ResourceActivityEventSchema>;
export const DiscussionActivityInputSchema = z
  .object({
    container: CloudResourceRefSchema.shape.id.describe("Container whose authorized activity is requested."),
    item: CloudResourceRefSchema.shape.id.optional().describe("Optional item inside that container."),
    timeZone: z.string().min(1).max(200).optional().describe("IANA display time zone."),
    before: z.string().datetime({ offset: true }).optional().describe("Exclusive upper timestamp bound."),
    after: z.string().datetime({ offset: true }).optional().describe("Exclusive lower timestamp bound."),
    cursor: cursor.optional(),
    limit: z.number().int().min(1).max(DISCUSSION_PAGE_LIMIT).default(50).describe("Maximum events in this page."),
  })
  .strict();
export const DiscussionActivityDataSchema = z.array(ResourceActivityEventSchema).max(DISCUSSION_PAGE_LIMIT);
export type DiscussionContainer = z.infer<typeof DiscussionContainerSchema>;

/** Startup/registry check: discovery is never permission to read content. */
export const discussionsIssues = (manifest: CapabilityManifest): CapabilityContractIssue[] => {
  const role = manifest.discussions;
  if (!role) return [];
  const model = manifest.resourceTypes?.find((model) => model.type === role.item);
  const issues: CapabilityContractIssue[] = [];
  if (!model?.container) issues.push({ code: "kind", path: "$.item", message: "Discussion item must have a container type" });
  for (const localId of [role.item, ...(model?.container ? [model.container] : [])]) issues.push(...typeViewIssues(manifest, localId));
  for (const [localId, input, data] of [
    [role.containers, DiscussionContainersInputSchema, DiscussionContainersDataSchema],
    ...(role.activity ? [[role.activity, DiscussionActivityInputSchema, DiscussionActivityDataSchema] as const] : []),
  ] as const) {
    const query = manifest.queries.find((query) => query.localId === localId);
    if (!query) issues.push({ code: "kind", path: "$", message: `Missing discussion Query ${localId}` });
    else {
      issues.push(...capabilityContractIssues({ kind: "query", input, data }, { kind: "query", operation: query }));
      if (query.appOnly || query.openWorld)
        issues.push({ code: "kind", path: "$", message: `Discussion Query ${localId} must be closed-world and person-readable` });
    }
  }
  return issues;
};
