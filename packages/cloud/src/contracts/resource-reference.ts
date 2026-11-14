import { z } from "zod";

// Reference-only consumers (including offline app frames) must not load capability registration schemas.
export const CAPABILITY_QUALIFIED_ID_MAX_LENGTH = 180;
export const CLOUD_RESOURCE_ID_MAX_LENGTH = 512;
const CAPABILITY_QUALIFIED_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export const CapabilityQualifiedIdSchema = z
  .string()
  .min(3)
  .max(CAPABILITY_QUALIFIED_ID_MAX_LENGTH)
  .regex(CAPABILITY_QUALIFIED_ID_PATTERN, "Expected a namespaced capability id such as contacts.contact");

export const CloudResourceRefSchema = z
  .object({
    type: CapabilityQualifiedIdSchema.describe("Namespaced resource type declared by the owning app."),
    id: z.string().min(1).max(CLOUD_RESOURCE_ID_MAX_LENGTH).describe("Stable app-owned resource identifier."),
  })
  .strict();

export type CloudResourceRef = z.infer<typeof CloudResourceRefSchema>;

export const CloudResourceReferenceSchema = CloudResourceRefSchema.extend({
  title: z.string().min(1).max(500).optional().describe("Optional current user-facing resource label."),
  preview: z.string().max(2000).optional().describe("Optional short plain-text context for the resource."),
  icon: z.string().min(1).max(120).optional().describe("Optional presentation icon for the resource."),
  context: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "One line in the caller's locale that says what and where the resource is and its most useful fact, for example 'Task in IT planning · due 30 Oct'.",
    ),
  status: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("The resource's current state as a short label in the caller's locale, for example 'Open' or 'Done'."),
}).strict();

export type CloudResourceReference = z.infer<typeof CloudResourceReferenceSchema>;
