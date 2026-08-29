import type { BaseUser } from "@/contracts";

type AccountLike = Pick<BaseUser, "provider" | "profile">;
type SupplementalRole = Extract<BaseUser["roles"][number], "admin" | "group-manager">;
type ProviderLike = AccountLike["provider"];

const PRIMARY_ACCOUNT_BADGES: Record<"user" | "guest", { className: string }> = {
  user: {
    className: "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300",
  },
  guest: {
    className: "bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300",
  },
};

const MANAGEMENT_BADGES: Record<"ipa" | "local", { className: string }> = {
  ipa: {
    className: "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300",
  },
  local: {
    className: "bg-sky-100 dark:bg-sky-900/50 text-sky-700 dark:text-sky-300",
  },
};

const SUPPLEMENTAL_ROLE_COLORS: Record<SupplementalRole, string> = {
  admin: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
  "group-manager": "bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300",
};

export const getPrimaryAccountBadge = (user: AccountLike) => PRIMARY_ACCOUNT_BADGES[user.profile];

export const getManagementBadge = (user: AccountLike) => MANAGEMENT_BADGES[user.provider];
export const getProviderBadge = (provider: ProviderLike) => MANAGEMENT_BADGES[provider];

export const getSupplementalRoles = (user: Pick<BaseUser, "roles">): SupplementalRole[] =>
  user.roles.filter((role): role is SupplementalRole => role === "admin" || role === "group-manager");

export const getSupplementalRoleColor = (role: SupplementalRole): string => SUPPLEMENTAL_ROLE_COLORS[role];
