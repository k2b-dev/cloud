import type { MarkProps, Person } from "@k2b/ui/v2";
import { cloudAvatarImage } from "../account/Avatar";
import type { Principal, ServiceAccountKind } from "../contracts/shared";

/** The kind colours of the v1 avatars, so a group, everyone signed in and Code read apart at a glance in both looks. */
const colors = { group: "#22c55e", authenticated: "#3b82f6", code: "#0369a1", key: "#64748b", public: "#d97706" } as const;

/**
 * How a principal shows on v2 (look rule 1: every thing carries its sign): a person or an agent as an avatar with its
 * picture, a group, Code's account, an object's API key and the audiences as a mark in their kind's colour.
 */
export const principalFace = (
  principal: Principal,
  name: string,
  display: { avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind },
): { avatar: Person } | { mark: MarkProps } => {
  if (principal.type === "group") return { mark: { icon: "users-group", color: colors.group } };
  if (principal.type === "authenticated") return { mark: { icon: "building", color: colors.authenticated } };
  if (principal.type === "public") return { mark: { icon: "world", color: colors.public } };
  if (principal.type === "service_account") {
    if (display.serviceAccountKind === "code" && !display.avatarHash) return { mark: { icon: "code", color: colors.code } };
    if (display.serviceAccountKind === "resource_bound") return { mark: { icon: "key", color: colors.key } };
    const image = cloudAvatarImage({ kind: "service_account", userId: principal.serviceAccountId, avatarHash: display.avatarHash });
    return { avatar: { name, ...(image ? { image } : {}) } };
  }
  const image = cloudAvatarImage({ kind: "user", userId: principal.userId, avatarHash: display.avatarHash });
  return { avatar: { name, ...(image ? { image } : {}) } };
};
