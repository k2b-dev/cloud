import { z } from "zod";
import type { RequestAuthority } from "../server/middleware/auth";
import { type Role, RoleSchema } from "./shared";

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
  z.object({ kind: z.literal("grants"), until: FixedAppAccessRuleSchema.optional(), publicRoutes }).strict(),
]);
/** Serializable entry rule evaluated by the platform; never application callback code. */
export type AppAccessRule = z.infer<typeof AppAccessRuleSchema>;
/** The optional management restriction runs in the owning application, in addition to a management grant. */
export type AppAccessDeclaration = AppAccessRule & {
  canManage?: (authority: RequestAuthority) => boolean | Promise<boolean>;
};
type PublicOptions = { publicRoutes?: readonly string[] };
export const appAccess = {
  signedIn: (options: PublicOptions = {}): AppAccessRule & { kind: "signedIn" } => ({ kind: "signedIn", ...options }),
  noGuests: (options: PublicOptions = {}): AppAccessRule & { kind: "noGuests" } => ({ kind: "noGuests", ...options }),
  roles: (roles: readonly Role[], options: PublicOptions = {}): AppAccessRule & { kind: "roles" } => ({ kind: "roles", roles, ...options }),
  grants: (
    options: PublicOptions & { until?: FixedAppAccessRule; canManage?: AppAccessDeclaration["canManage"] } = {},
  ): AppAccessDeclaration => ({ kind: "grants", ...options }),
};

export const compileAppAccess = (declaration: AppAccessDeclaration | undefined): AppAccessRule | undefined => {
  if (!declaration) return undefined;
  const { canManage, ...rule } = declaration;
  if (canManage && (rule.kind !== "grants" || typeof canManage !== "function"))
    throw new Error("Only configurable app access accepts canManage");
  return AppAccessRuleSchema.parse(rule);
};
