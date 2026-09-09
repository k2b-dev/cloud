import { UserProfileSchema, UserProviderSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

export const CreateGroupSchema = z.object({
  provider: UserProviderSchema.default("ipa"),
  name: z
    .string()
    .max(120)
    .min(1)
    .transform((value) =>
      value
        .toLowerCase()
        .replace(/[_ ]/g, "-")
        .replace(/[^a-z0-9-]/g, ""),
    ),
  description: z.string().max(4_000).optional(),
  posix: z.boolean().optional().default(false),
});

export const UpdateGroupSchema = z.object({
  description: z.string().max(4_000),
});

export const GroupMemberInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    id: z.uuid(),
  }),
  z.object({
    type: z.literal("group"),
    id: z.uuid(),
  }),
]);
export type GroupMemberInput = z.infer<typeof GroupMemberInputSchema>;

export const CreateUserResponseSchema = z.object({
  id: z.string(),
  uid: z.string(),
  accountExpires: z.string().nullable(),
  notificationSent: z.boolean(),
  creationNotice: z.object({ markdown: z.string().nullable(), failed: z.boolean() }).optional(),
});
export type CreateUserResponse = z.infer<typeof CreateUserResponseSchema>;

const CreateUserSharedSchema = {
  email: z.email(),
  givenname: z.string().min(1).max(120),
  sn: z.string().min(1).max(120),
  displayName: z.string().max(160).optional(),
  autoSendNotification: z.boolean().default(false),
  requestId: z.uuid().optional(),
};

export const CreateUserSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("ipa"),
    ...CreateUserSharedSchema,
  }),
  z
    .object({
      provider: z.literal("local"),
      profile: UserProfileSchema,
      admin: z.boolean().optional().default(false),
      ...CreateUserSharedSchema,
    })
    .refine((value) => value.profile === "user" || !value.admin, {
      message: "Only local full accounts can be created as admins",
      path: ["admin"],
    }),
]);
export type CreateUser = z.infer<typeof CreateUserSchema>;

export type {
  BaseGroup,
  BaseUser,
  EntityListItem,
  PaginationResponse,
  User,
} from "@k2b/cloud/contracts";
export {
  BaseGroupSchema,
  BaseUserSchema,
  createPagination,
  ErrorResponseSchema,
  hasRole,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
  SearchQuerySchema,
} from "@k2b/cloud/contracts";
