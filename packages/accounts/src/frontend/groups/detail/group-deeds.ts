import { apiClient } from "@/api/client";
import { ErrorResponseSchema } from "@/contracts";
import { showAccountActionNotice } from "../../action-notice";
import type { AccountsMessages } from "../../messages";
import type { EntityType } from "./group-screen";

/** A deed's answer: done, or the server's own words for why not (or the deed's fallback). */
export type DeedResult = { ok: true } | { ok: false; message: string };

type Words = Pick<AccountsMessages, "actionNotice" | "creationNoticeFailed">;

const failed = async (response: { json: () => Promise<unknown> } | null, fallback: string): Promise<DeedResult> => {
  const body = response ? ErrorResponseSchema.safeParse(await response.json().catch(() => null)) : null;
  return { ok: false, message: body?.success ? body.data.message : fallback };
};

/**
 * The membership and group deeds of a group's page. Each one writes through the same API as before and shows the
 * action notice (follow-up steps an operator configured) only after the change succeeded.
 */
export const groupDeeds = (group: { id: string; storedName: string; provider: "ipa" | "local" }, words: () => Words) => ({
  /** Adds a member or a manager. */
  add: async (role: "members" | "managers", entity: { type: EntityType; id: string }, fallback: string): Promise<DeedResult> => {
    const response = await (role === "members"
      ? apiClient.groups[":id"].members.$post({ param: { id: group.id }, json: entity })
      : apiClient.groups[":id"].managers.$post({ param: { id: group.id }, json: entity })
    ).catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice(
      {
        action: role === "members" ? "group.member.add" : "group.manager.add",
        id: group.id,
        provider: group.provider,
        relatedId: entity.id,
      },
      words(),
    );
    return { ok: true };
  },
  /** Removes a direct member or a manager. */
  remove: async (role: "members" | "managers", entity: { type: EntityType; id: string }, fallback: string): Promise<DeedResult> => {
    const response = await (role === "members"
      ? apiClient.groups[":id"].members.$delete({ param: { id: group.id }, json: entity })
      : apiClient.groups[":id"].managers.$delete({ param: { id: group.id }, json: entity })
    ).catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice(
      { action: role === "members" ? "group.member.remove" : "group.manager.remove", id: group.id, relatedId: entity.id },
      words(),
    );
    return { ok: true };
  },
  /** Makes this group a member of another group. */
  join: async (parentId: string, fallback: string): Promise<DeedResult> => {
    const response = await apiClient.groups[":id"].members
      .$post({ param: { id: parentId }, json: { type: "group", id: group.id } })
      .catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice({ action: "group.member.add", id: parentId, provider: group.provider, relatedId: group.id }, words());
    return { ok: true };
  },
  /** Takes this group out of a group that contains it. */
  leave: async (parent: { id: string; name: string }, fallback: string): Promise<DeedResult> => {
    const response = await apiClient.groups[":id"].members
      .$delete({ param: { id: parent.id }, json: { type: "group", id: group.id } })
      .catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice({ action: "group.member.remove", id: parent.id, name: parent.name, relatedId: group.id }, words());
    return { ok: true };
  },
  describe: async (description: string, fallback: string): Promise<DeedResult> => {
    const response = await apiClient.groups[":id"].$patch({ param: { id: group.id }, json: { description } }).catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice({ action: "group.update", id: group.id, name: group.storedName, provider: group.provider }, words());
    return { ok: true };
  },
  posix: async (fallback: string): Promise<DeedResult> => {
    const response = await apiClient.groups[":id"].posix.$put({ param: { id: group.id } }).catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice({ action: "group.posix", id: group.id, name: group.storedName, provider: group.provider }, words());
    return { ok: true };
  },
  delete: async (fallback: string): Promise<DeedResult> => {
    const response = await apiClient.groups[":id"].$delete({ param: { id: group.id } }).catch(() => null);
    if (!response?.ok) return failed(response, fallback);
    await showAccountActionNotice({ action: "group.delete", id: group.id, name: group.storedName, provider: group.provider }, words());
    return { ok: true };
  },
});
