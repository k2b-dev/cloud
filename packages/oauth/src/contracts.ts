import { PaginationQuerySchema, PaginationResponseSchema } from "@k2b/cloud/contracts";
import { z } from "zod";

const MAX_URL_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 1_000;
const MAX_NAME_LENGTH = 120;
const MAX_ARRAY_ITEMS = 50;

const UrlSchema = z.string().trim().max(MAX_URL_LENGTH).pipe(z.url());
const TextSchema = z.string().trim().max(MAX_TEXT_LENGTH);
const NameSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const AudienceSchema = z.string().trim().min(1).max(255);
const dedupe = <T>(values: T[]): T[] => Array.from(new Set(values));

export const OAuthScopeSchema = z.enum(["openid", "profile", "email", "groups", "offline_access", "read", "write", "admin"]);
export type OAuthScope = z.infer<typeof OAuthScopeSchema>;

export const OAuthAllowedProfileSchema = z.enum(["user", "guest"]);
export type OAuthAllowedProfile = z.infer<typeof OAuthAllowedProfileSchema>;

export const OAuthAccessModeSchema = z.enum(["profiles", "specific"]);
export type OAuthAccessMode = z.infer<typeof OAuthAccessModeSchema>;

export const OAuthClientRegistrationKindSchema = z.enum(["managed", "first_party", "dynamic"]);
export type OAuthClientRegistrationKind = z.infer<typeof OAuthClientRegistrationKindSchema>;

const AllowedProfilesSchema = z
  .array(OAuthAllowedProfileSchema)
  .max(MAX_ARRAY_ITEMS)
  .transform(dedupe)
  .refine((values) => values.length <= 2, "Allowed profiles must not contain more than two distinct values");
const IdListSchema = z.array(z.uuid()).max(MAX_ARRAY_ITEMS).transform(dedupe);

export const OAuthAccessUserSchema = z.object({
  id: z.uuid(),
  uid: z.string(),
  displayName: z.string(),
  mail: z.string().nullable(),
  provider: z.enum(["ipa", "local"]),
});

export const OAuthAccessGroupSchema = z.object({
  id: z.uuid(),
  provider: z.enum(["ipa", "local"]),
  name: z.string(),
  description: z.string().nullable(),
});

export const OAuthClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  clientId: z.string(),
  redirectUris: z.array(z.string()),
  logoutUri: z.string().nullable(),
  scopes: z.array(OAuthScopeSchema),
  audiences: z.array(z.string()),
  serviceAccountId: z.uuid().nullable(),
  allowedProfiles: z.array(OAuthAllowedProfileSchema),
  accessMode: OAuthAccessModeSchema,
  accessUsers: z.array(OAuthAccessUserSchema),
  accessGroups: z.array(OAuthAccessGroupSchema),
  registrationKind: OAuthClientRegistrationKindSchema,
  isPublic: z.boolean(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

export const OAuthClientWithSecretSchema = OAuthClientSchema.extend({
  clientSecret: z.string(),
});

export const OAuthClientListQuerySchema = z.object({
  ...PaginationQuerySchema.shape,
  search: z.string().trim().max(200).optional(),
});

export const OAuthClientListResponseSchema = z.object({
  clients: z.array(OAuthClientSchema),
  pagination: PaginationResponseSchema,
});

export const OAuthClientParamSchema = z.object({
  id: z.uuid(),
});

export const CreateOAuthClientSchema = z.object({
  name: NameSchema,
  description: TextSchema.optional(),
  redirectUris: z.array(UrlSchema).max(MAX_ARRAY_ITEMS).transform(dedupe).default([]),
  logoutUri: UrlSchema.optional(),
  scopes: z.array(OAuthScopeSchema).max(MAX_ARRAY_ITEMS).transform(dedupe).default(["openid", "profile", "email"]),
  audiences: z.array(AudienceSchema).max(MAX_ARRAY_ITEMS).transform(dedupe).default(["cloud"]),
  serviceAccountId: z.uuid().nullable().optional(),
  allowedProfiles: AllowedProfilesSchema.default(["user", "guest"]),
  accessMode: OAuthAccessModeSchema.default("profiles"),
  allowedUserIds: IdListSchema.default([]),
  allowedGroupIds: IdListSchema.default([]),
  isPublic: z.boolean().default(false),
});

export const UpdateOAuthClientSchema = z.object({
  name: NameSchema.optional(),
  description: TextSchema.nullable().optional(),
  redirectUris: z.array(UrlSchema).max(MAX_ARRAY_ITEMS).transform(dedupe).optional(),
  logoutUri: UrlSchema.nullable().optional(),
  scopes: z.array(OAuthScopeSchema).max(MAX_ARRAY_ITEMS).transform(dedupe).optional(),
  audiences: z.array(AudienceSchema).max(MAX_ARRAY_ITEMS).transform(dedupe).optional(),
  serviceAccountId: z.uuid().nullable().optional(),
  allowedProfiles: AllowedProfilesSchema.optional(),
  accessMode: OAuthAccessModeSchema.optional(),
  allowedUserIds: IdListSchema.optional(),
  allowedGroupIds: IdListSchema.optional(),
});

export type OAuthClient = z.infer<typeof OAuthClientSchema>;
export type OAuthClientWithSecret = z.infer<typeof OAuthClientWithSecretSchema>;
export type OAuthClientListResponse = z.infer<typeof OAuthClientListResponseSchema>;
export type OAuthAccessUser = z.infer<typeof OAuthAccessUserSchema>;
export type OAuthAccessGroup = z.infer<typeof OAuthAccessGroupSchema>;
export type CreateOAuthClient = z.infer<typeof CreateOAuthClientSchema>;
export type UpdateOAuthClient = z.infer<typeof UpdateOAuthClientSchema>;

export const DYNAMIC_CLIENT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "read",
  "write",
] as const satisfies readonly OAuthScope[];

const DynamicRedirectUriSchema = UrlSchema.refine((value) => {
  const url = new URL(value);
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}, "Redirect URI must use HTTPS or an HTTP loopback host and must not contain credentials or a fragment");

const DynamicScopeListSchema = z
  .string()
  .trim()
  .max(MAX_TEXT_LENGTH)
  .transform((value) => Array.from(new Set(value.split(/\s+/).filter(Boolean))))
  .refine(
    (scopes) => scopes.every((scope) => DYNAMIC_CLIENT_SCOPES.includes(scope as (typeof DYNAMIC_CLIENT_SCOPES)[number])),
    "Dynamic clients may only request supported delegated scopes",
  )
  .transform((scopes) => scopes.join(" "));

const DynamicClientNameSchema = NameSchema.refine(
  (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
  "Client name must not contain control or formatting characters",
);

export const DynamicClientRegistrationRequestSchema = z.object({
  client_name: DynamicClientNameSchema.default("Dynamic OAuth Client"),
  application_type: z.enum(["native", "web"]).optional(),
  redirect_uris: z.array(DynamicRedirectUriSchema).min(1).max(10).transform(dedupe),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .min(1)
    .max(2)
    .transform(dedupe)
    .default(["authorization_code"]),
  response_types: z.array(z.literal("code")).min(1).max(1).transform(dedupe).default(["code"]),
  token_endpoint_auth_method: z.literal("none").default("none"),
  scope: DynamicScopeListSchema.optional(),
});

export const DynamicClientRegistrationResponseSchema = DynamicClientRegistrationRequestSchema.extend({
  client_id: z.string().min(1),
  client_id_issued_at: z.number().int().nonnegative(),
});

export const DynamicClientRegistrationErrorSchema = z.object({
  error: z.enum(["invalid_redirect_uri", "invalid_client_metadata"]),
  error_description: z.string(),
});

export type DynamicClientRegistrationRequest = z.infer<typeof DynamicClientRegistrationRequestSchema>;
export type DynamicClientRegistrationResponse = z.infer<typeof DynamicClientRegistrationResponseSchema>;

export type { MutationResult } from "@k2b/cloud/contracts";
export {
  createPagination,
  ErrorResponseSchema,
  MessageResponseSchema,
  PaginationQuerySchema,
  PaginationResponseSchema,
  parsePagination,
} from "@k2b/cloud/contracts";
