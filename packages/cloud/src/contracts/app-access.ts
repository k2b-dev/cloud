import type { SQL } from "bun";
import { z } from "zod";
import type { RequestAuthority } from "../server/middleware/auth";
import type { ResourceAccessAdapter } from "../server/services/access";
import { AccessEntrySchema, type Role, RoleSchema } from "./shared";

const publicRoutes = z
  .array(
    z
      .string()
      .startsWith("/")
      .refine((path) => !path.startsWith("//") && !/[?#]/.test(path)),
  )
  .readonly()
  .optional();
export const FixedAppAccessRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("signedIn") }).strict(),
  z.object({ kind: z.literal("noGuests") }).strict(),
  z.object({ kind: z.literal("roles"), roles: z.array(RoleSchema).min(1).readonly() }).strict(),
]);
export type FixedAppAccessRule = z.infer<typeof FixedAppAccessRuleSchema>;
export const AppAccessRuleSchema = z.union([
  z.object({ kind: z.literal("signedIn"), publicRoutes }).strict(),
  z.object({ kind: z.literal("noGuests"), publicRoutes }).strict(),
  z.object({ kind: z.literal("roles"), roles: z.array(RoleSchema).min(1).readonly(), publicRoutes }).strict(),
  z.object({ kind: z.literal("resources"), adapters: z.array(z.string().min(1)).min(1).readonly(), publicRoutes }).strict(),
  z.object({ kind: z.literal("grants"), until: FixedAppAccessRuleSchema.optional(), publicRoutes }).strict(),
]);
/** Serializable entry rule evaluated by the platform; never application callback code. */
export type AppAccessRule = z.infer<typeof AppAccessRuleSchema>;
/**
 * The optional management restriction runs in the owning application, in addition to a management grant.
 * SQL-backed callbacks and domain services they call must use the supplied db: edits hold its transaction connection.
 */
export type AppAccessDeclaration = (
  | Exclude<AppAccessRule, { kind: "resources" }>
  | {
      kind: "resources";
      adapters: Readonly<Record<string, ResourceAppAccessAdapter>>;
      publicRoutes?: readonly string[];
    }
) & {
  canManage?: (authority: RequestAuthority, context: { db: SQL }) => boolean | Promise<boolean>;
};
/** An existence query is required for resource-derived app access; list() cannot answer it without a resource scan. */
export type ResourceAppAccessAdapter = Required<Pick<ResourceAccessAdapter, "hasAnyRight">>;
type PublicOptions = { publicRoutes?: readonly string[] };
export const appAccess = {
  resources: (
    options: PublicOptions & { adapters: Readonly<Record<string, ResourceAppAccessAdapter>> },
  ): Extract<AppAccessDeclaration, { kind: "resources" }> => ({
    kind: "resources",
    ...options,
  }),
  signedIn: (options: PublicOptions = {}): AppAccessRule & { kind: "signedIn" } => ({ kind: "signedIn", ...options }),
  noGuests: (options: PublicOptions = {}): AppAccessRule & { kind: "noGuests" } => ({ kind: "noGuests", ...options }),
  roles: (roles: readonly Role[], options: PublicOptions = {}): AppAccessRule & { kind: "roles" } => ({ kind: "roles", roles, ...options }),
  grants: (
    options: PublicOptions & { until?: FixedAppAccessRule; canManage?: AppAccessDeclaration["canManage"] } = {},
  ): Extract<AppAccessDeclaration, { kind: "grants" }> => ({ kind: "grants", ...options }),
};

export const compileAppAccess = (declaration: AppAccessDeclaration | undefined): AppAccessRule | undefined => {
  if (!declaration) return undefined;
  const { canManage, ...rule } = declaration;
  if (canManage && (rule.kind !== "grants" || typeof canManage !== "function"))
    throw new Error("Only configurable app access accepts canManage");
  if (rule.kind === "resources") {
    if (Array.isArray(rule.adapters)) throw new Error("Declare resource adapters, not registry metadata");
    for (const adapter of Object.values(rule.adapters)) {
      if (typeof adapter.hasAnyRight !== "function") throw new Error("Resource app access requires hasAnyRight on every adapter");
    }
    return AppAccessRuleSchema.parse({ ...rule, adapters: Object.keys(rule.adapters) });
  }
  return AppAccessRuleSchema.parse(rule);
};

export const AppAccessSnapshotSchema = z.object({
  appId: z.string(),
  name: z.string(),
  entries: z.array(
    AccessEntrySchema.extend({
      id: z.union([z.uuid(), z.literal("inherited-authenticated")]),
      groupMemberCount: z.number().int().nonnegative().optional(),
      /** Platform eligibility for presentation; the server still checks any app-owned restriction. */
      effectiveManager: z.boolean().optional(),
    }),
  ),
  ownEntryIds: z.array(z.string()),
  configured: z.boolean(),
  hasEffectiveManager: z.boolean(),
  inheritedSignedIn: z.boolean(),
  canUse: z.boolean(),
});
export type AppAccessSnapshot = z.infer<typeof AppAccessSnapshotSchema>;
