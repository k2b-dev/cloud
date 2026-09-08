import type { BaseUser } from "@/contracts";

type SupplementalRole = Extract<BaseUser["roles"][number], "admin" | "group-manager">;

export const getSupplementalRoles = (user: Pick<BaseUser, "roles">): SupplementalRole[] =>
  user.roles.filter((role): role is SupplementalRole => role === "admin" || role === "group-manager");
