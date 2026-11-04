import type { DetailAccessEntry } from "@k2b/ui";
import { cloudAvatarSource } from "../account/Avatar";
import type { AccessMember } from "../contracts/shared";
import { accessMessages } from "./messages";
import { principalLabel } from "./principal-label";

/**
 * The rows of a detail panel's `DetailAccess` section for a resource's `AccessMember` list: name, avatar, and role in
 * the words of the access dialog, with the viewer marked. Grants without a permission are left out. Load the list
 * only from an endpoint that answers people with access of their own (`getMemberPermission`).
 */
export const accessMemberEntries = (
  members: readonly AccessMember[],
  options: { currentUserId?: string | null; locale: string | null | undefined },
): DetailAccessEntry[] => {
  const { t } = accessMessages.resolve([options.locale ?? "en"]);
  const role = (permission: AccessMember["permission"]) => (permission === "admin" ? t.manage : permission === "write" ? t.edit : t.view);
  return members
    .filter((member) => member.permission !== "none")
    .map((member): DetailAccessEntry => {
      const { principal } = member;
      const name = principalLabel(member, options.locale);
      switch (principal.type) {
        case "user":
          return {
            id: `user:${principal.userId}`,
            name,
            kind: "person",
            src: cloudAvatarSource(principal.userId, member.avatarHash),
            role: role(member.permission),
            self: principal.userId === options.currentUserId,
          };
        case "group":
          return { id: `group:${principal.groupId}`, name, kind: "group", role: role(member.permission) };
        case "service_account":
          return {
            id: `service:${principal.serviceAccountId}`,
            name,
            kind: "service",
            detail: member.serviceAccountKind === "agent" ? t.agentServiceAccount : t.resourceBoundServiceAccount,
            role: role(member.permission),
          };
        case "authenticated":
          return { id: "everyone", name, kind: "everyone", role: role(member.permission) };
        default:
          return { id: "public", name, kind: "public", role: role(member.permission) };
      }
    });
};
