import { aiProjects, aiSkills } from "@k2b/cloud/ai";
import type { CloudResourceRef } from "@k2b/cloud/contracts/capabilities";
import type { RequestAuthority } from "@k2b/cloud/server";

/** Core's AI targets have no Manage reader view. Use the same local grants and admin recovery as their access routes. */
export const managesAiPrincipalSearchTarget = async (
  target: CloudResourceRef,
  authority: RequestAuthority,
): Promise<boolean | undefined> => {
  if (target.type !== "core.ai.skill" && target.type !== "core.ai.project") return undefined;
  if (
    authority.actor.kind !== "user" ||
    authority.accessSubject.type !== "user" ||
    authority.accessSubject.userId !== authority.actor.user.id
  )
    return false;
  try {
    if (authority.actor.user.roles.includes("admin")) {
      return target.type === "core.ai.skill"
        ? Boolean(await aiSkills.admin.getByShortId(target.id))
        : Boolean(await aiProjects.admin.getByShortId(target.id));
    }
    return target.type === "core.ai.skill"
      ? Boolean(await aiSkills.getByShortId(target.id, authority, "admin", authority))
      : Boolean(await aiProjects.getByShortId(target.id, authority, "admin"));
  } catch {
    return false;
  }
};
