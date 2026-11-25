import { openProfilePictureDialog } from "@k2b/cloud/account/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { AvatarStateSchema, SaveServiceAccountAvatarSchema } from "@k2b/cloud/contracts/profile";
import { usePageSwap } from "@/frontend/lib/page-swap";
import { useAccountsMessages } from "../messages";

/**
 * "Change profile picture" for an agent: photo and robot, saved through the administration API; a change shows the page
 * again with the new picture. Call it while the island renders.
 */
export const useAgentPictureChange = (agent: () => { id: string; name: string }) => {
  const { showChanges } = usePageSwap();
  const messages = useAccountsMessages();
  const route = () => apiClient.admin.identity["service-accounts"][":id"].avatar;
  const read = async (response: { ok: boolean; json: () => Promise<unknown> }) => {
    if (!response.ok) throw new Error(messages().agentPictureFailed);
    return AvatarStateSchema.parse(await response.json());
  };
  return async () => {
    const param = { id: agent().id };
    const changed = await openProfilePictureDialog({
      subject: "agent",
      name: agent().name,
      load: async () => read(await route().$get({ param })),
      save: async (next) => read(await route().$put({ param, json: SaveServiceAccountAvatarSchema.parse(next) })),
      deletePhoto: async () => read(await route().$delete({ param })),
    });
    if (changed) await showChanges();
  };
};
