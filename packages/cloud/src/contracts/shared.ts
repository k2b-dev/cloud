import { z } from "zod";

export const RoleSchema = z.enum([
  "admin",
  "ipa",
  "guest",
  "group-manager",
  "local",
  "user",
  "ipa/user",
  "ipa/guest",
  "local/user",
  "local/guest",
]);
export type Role = z.infer<typeof RoleSchema>;

export const UserProviderSchema = z.enum(["ipa", "local"]);
export type UserProvider = z.infer<typeof UserProviderSchema>;

export const UserProfileSchema = z.enum(["user", "guest"]);
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const SpecialRoleSchema = z.enum(["*", "authenticated", "anonymous"]);
export type SpecialRole = z.infer<typeof SpecialRoleSchema>;
export type RoleOrSpecial = Role | SpecialRole;

export const hasRole = (user: { roles: Role[] }, ...roles: Role[]): boolean => roles.some((role) => user.roles.includes(role));

export const BaseUserSchema = z.object({
  id: z.string(),
  uid: z.string(),
  roles: z.array(RoleSchema),
  provider: UserProviderSchema,
  profile: UserProfileSchema,
  givenname: z.string(),
  sn: z.string(),
  displayName: z.string(),
  mail: z.string().nullable(),
  avatarHash: z.string().nullable(),
});
export type BaseUser = z.infer<typeof BaseUserSchema>;

export const IpaUserDataSchema = z.object({
  uidNumber: z.number().nullable(),
  phone: z.string().nullable(),
  employeeType: z.string().nullable(),
  mobile: z.string().nullable(),
  address: z.object({
    street: z.string().nullable(),
    postalCode: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
  }),
  passwordExpires: z.string().nullable(),
  lastLoginIpa: z.string().nullable(),
  syncedAt: z.string().nullable(),
  sshPublicKeys: z.array(z.string()),
  sshFingerprints: z.array(z.string()),
});
export type IpaUserData = z.infer<typeof IpaUserDataSchema>;

const RichUserFields = {
  accountExpires: z.string().nullable(),
  lastLoginLocal: z.string().nullable(),
  memberofGroup: z.array(z.string()),
  memberofGroupIds: z.array(z.uuid()),
  manages: z.array(z.string()),
  managesGroupIds: z.array(z.uuid()),
} satisfies z.ZodRawShape;

export const IpaUserSchema = BaseUserSchema.extend({
  provider: z.literal("ipa"),
  ipa: IpaUserDataSchema,
  ...RichUserFields,
});
export type IpaUser = z.infer<typeof IpaUserSchema>;

export const LocalUserSchema = BaseUserSchema.extend({
  provider: z.literal("local"),
  ipa: z.null(),
  ...RichUserFields,
});
export type LocalUser = z.infer<typeof LocalUserSchema>;

export const UserSchema = z.discriminatedUnion("provider", [IpaUserSchema, LocalUserSchema]);
export type User = z.infer<typeof UserSchema>;

export const BaseGroupSchema = z.object({
  id: z.uuid(),
  provider: UserProviderSchema,
  name: z.string(),
  description: z.string().nullable(),
  gidnumber: z.number().nullable(),
});
export type BaseGroup = z.infer<typeof BaseGroupSchema>;

export const EntityKindSchema = z.enum(["user", "group", "service_account"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityRelationSchema = z.object({
  direct: z.boolean().optional(),
});
export type EntityRelation = z.infer<typeof EntityRelationSchema>;

export const EntityListItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    user: BaseUserSchema,
    relation: EntityRelationSchema.optional(),
  }),
  z.object({
    kind: z.literal("group"),
    group: BaseGroupSchema,
    relation: EntityRelationSchema.optional(),
  }),
  z.object({
    kind: z.literal("service_account"),
    serviceAccount: z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.enum(["user_delegated", "resource_bound"]),
      status: z.enum(["active", "disabled"]),
      delegatedUserId: z.uuid().nullable(),
      appId: z.string().nullable(),
      resourceType: z.string().nullable(),
      resourceId: z.string().nullable(),
      createdBy: z.uuid().nullable(),
      createdAt: z.string(),
    }),
    relation: EntityRelationSchema.optional(),
  }),
]);
export type EntityListItem = z.infer<typeof EntityListItemSchema>;

export const GroupMemberSchema = z.object({
  type: z.enum(["user", "group"]),
  id: z.string(),
  displayName: z.string().nullable(),
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;

export const SearchQuerySchema = z.object({
  search: z.string().optional(),
});

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  per_page: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginationResponseSchema = z.object({
  page: z.number(),
  per_page: z.number(),
  total: z.number(),
  total_pages: z.number(),
  has_next: z.boolean(),
});
export type PaginationResponse = z.infer<typeof PaginationResponseSchema>;

export type PaginationParams = {
  page: number;
  perPage: number;
  offset: number;
};

export const parsePagination = (query: { page?: number; per_page?: number }): PaginationParams => {
  const page = query.page ?? 1;
  const perPage = query.per_page ?? 20;
  const offset = (page - 1) * perPage;
  return { page, perPage, offset };
};

export const createPagination = (params: PaginationParams, total: number): PaginationResponse => {
  const totalPages = Math.ceil(total / params.perPage);
  return {
    page: params.page,
    per_page: params.perPage,
    total,
    total_pages: totalPages,
    has_next: params.page < totalPages,
  };
};

export const ErrorResponseSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const MessageResponseSchema = z.object({
  message: z.string(),
});
export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export type MutationResult<T = void> = { ok: true; data: T } | { ok: false; error: string; status: 400 | 401 | 403 | 404 | 409 | 500 };

export const PermissionLevelSchema = z.enum(["none", "read", "write", "admin"]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

export const ServiceAccountKindSchema = z.enum(["user_delegated", "resource_bound"]);
export type ServiceAccountKind = z.infer<typeof ServiceAccountKindSchema>;

export const ServiceAccountStatusSchema = z.enum(["active", "disabled"]);
export type ServiceAccountStatus = z.infer<typeof ServiceAccountStatusSchema>;

export const ServiceAccountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: ServiceAccountKindSchema,
  status: ServiceAccountStatusSchema,
  delegatedUserId: z.uuid().nullable(),
  appId: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

export const ServiceAccountCredentialStatusSchema = z.enum(["active", "revoked"]);
export type ServiceAccountCredentialStatus = z.infer<typeof ServiceAccountCredentialStatusSchema>;

export const ServiceAccountCredentialSchema = z.object({
  id: z.uuid(),
  serviceAccountId: z.uuid(),
  name: z.string(),
  kind: z.literal("api_token"),
  status: ServiceAccountCredentialStatusSchema,
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdBy: z.uuid().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: z.uuid().nullable(),
});
export type ServiceAccountCredential = z.infer<typeof ServiceAccountCredentialSchema>;

export const CreateUserApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreateUserApiKey = z.infer<typeof CreateUserApiKeySchema>;

export const CreateUserApiKeyResponseSchema = z.object({
  credential: ServiceAccountCredentialSchema,
  token: z.string(),
});
export type CreateUserApiKeyResponse = z.infer<typeof CreateUserApiKeyResponseSchema>;

export const WebAuthnPasskeySchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  transports: z.array(z.string()),
  deviceType: z.string().nullable(),
  backedUp: z.boolean(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type WebAuthnPasskey = z.infer<typeof WebAuthnPasskeySchema>;

export const CreateWebAuthnPasskeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  response: z.unknown(),
});
export type CreateWebAuthnPasskey = z.infer<typeof CreateWebAuthnPasskeySchema>;

export const ListWebAuthnPasskeysResponseSchema = z.object({
  items: z.array(WebAuthnPasskeySchema),
});
export type ListWebAuthnPasskeysResponse = z.infer<typeof ListWebAuthnPasskeysResponseSchema>;

export const AccountActivitySchema = z.object({
  id: z.number(),
  createdAt: z.string(),
  action: z.string(),
  label: z.string(),
  outcome: z.enum(["allowed", "denied", "failed"]),
  context: z.string().nullable(),
});
export type AccountActivity = z.infer<typeof AccountActivitySchema>;

export const AccountActivityListResponseSchema = z.object({
  items: z.array(AccountActivitySchema),
});
export type AccountActivityListResponse = z.infer<typeof AccountActivityListResponseSchema>;

export const PrincipalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.uuid() }),
  z.object({ type: z.literal("group"), groupId: z.uuid() }),
  z.object({ type: z.literal("service_account"), serviceAccountId: z.uuid() }),
  z.object({ type: z.literal("authenticated") }),
  z.object({ type: z.literal("public") }),
]);
export type Principal = z.infer<typeof PrincipalSchema>;

export const AccessEntrySchema = z.object({
  id: z.uuid(),
  principal: PrincipalSchema,
  permission: PermissionLevelSchema,
  createdAt: z.string(),
  displayName: z.string().optional(),
  avatarHash: z.string().nullable().optional(),
});
export type AccessEntry = z.infer<typeof AccessEntrySchema>;

export const NotebookPresenceParticipantSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  avatarHash: z.string().nullable().optional(),
  color: z.string(),
  peerCount: z.number().int().positive(),
  joinedAt: z.string(),
});
export type NotebookPresenceParticipant = z.infer<typeof NotebookPresenceParticipantSchema>;

export const GrantAccessSchema = z.object({
  principal: PrincipalSchema,
  permission: PermissionLevelSchema,
});
export type GrantAccess = z.infer<typeof GrantAccessSchema>;

export const UpdateAccessSchema = z.object({
  permission: PermissionLevelSchema,
});
export type UpdateAccess = z.infer<typeof UpdateAccessSchema>;

// ── Settings (browser-safe types) ────────────────────────────────────

export type SettingKind =
  | "string"
  | "text"
  | "email"
  | "url"
  | "secret"
  | "image"
  | "boolean"
  | "number"
  | "enum"
  | "string_list"
  | "number_list"
  | "cron"
  | "timezone"
  | "template";

export type SettingOption = {
  value: string;
  label: string;
};

export type SettingValueSource = "custom" | "env" | "default";

export type SettingEntry = {
  key: string;
  label: string;
  kind: SettingKind;
  description: string;
  placeholder?: string;
  group: string;
  value: unknown;
  default: unknown;
  resetValue: unknown;
  valueSource: SettingValueSource;
  resetValueSource: Exclude<SettingValueSource, "custom">;
  isCustom: boolean;
  templateVars?: string[];
  options?: SettingOption[];
  min?: number;
  max?: number;
};

// ── Request model ───────────────────────────────────────────────────────────
// `RequestActor` answers "which credential acted?", `AccessSubject` answers
// "whose grants should be checked?". They differ for a user-bound credential:
// the actor is a service account, the subject is its user.

export type InvocationProvenance = {
  kind: "invocation";
  callingAppId: string;
  credentialKind: "session" | "oauth" | "api_key" | "mandate";
  invocationId: string;
  requestId?: string | null;
  mandateId?: string;
  mandateRevision?: number;
  workloadType?: string;
  workloadId?: string;
};

export type UserRequestActor = { kind: "user"; user: User; delegation?: InvocationProvenance };

export type ServiceAccountRequestActor = {
  kind: "service_account";
  serviceAccount: ServiceAccount;
  delegatedUser: User | null;
  scopes: string[];
  credentialId?: string | null;
  credentialExpiresAt?: string | null;
  delegation?: InvocationProvenance;
};

export type RequestActor = UserRequestActor | ServiceAccountRequestActor;

export type AccessSubject =
  | { type: "user"; userId: string; delegatedByServiceAccountId?: string | null }
  | { type: "service_account"; serviceAccountId: string };
