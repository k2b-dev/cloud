import { z } from "zod";

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_GROUPS = 100;

const dedupe = <T>(values: T[]): T[] => Array.from(new Set(values));

const GroupIdsSchema = z
  .array(z.uuid())
  .max(MAX_GROUPS)
  .transform(dedupe)
  .refine((ids) => ids.length > 0, "At least one group is required.");

export const ProxyAuthAllowedGroupSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.enum(["ipa", "local"]),
});
export type ProxyAuthAllowedGroup = z.infer<typeof ProxyAuthAllowedGroupSchema>;

export const ProxyAuthClientSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  clientId: z.string(),
  description: z.string().nullable(),
  allowedGroups: z.array(ProxyAuthAllowedGroupSchema),
  createdAt: z.string(),
});
export type ProxyAuthClient = z.infer<typeof ProxyAuthClientSchema>;

export const ProxyAuthClientParamSchema = z.object({
  id: z.uuid(),
});

export const CreateProxyAuthClientSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).optional(),
  allowedGroupIds: GroupIdsSchema,
});
export type CreateProxyAuthClient = z.infer<typeof CreateProxyAuthClientSchema>;

export const UpdateProxyAuthClientSchema = z.object({
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).nullable().optional(),
  allowedGroupIds: GroupIdsSchema.optional(),
});
export type UpdateProxyAuthClient = z.infer<typeof UpdateProxyAuthClientSchema>;

export { ErrorResponseSchema, MessageResponseSchema } from "@k2b/cloud/contracts";
