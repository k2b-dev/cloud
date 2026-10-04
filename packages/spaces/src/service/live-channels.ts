import type { LiveViewer } from "@k2b/cloud/events";
import { hasPermission } from "@k2b/cloud/server";
import { z } from "zod";
import { ResourceShortIdSchema } from "../contracts";
import { getActorsSpacePermissions } from "./access";
import { spacesPublicResources } from "./public-resources";

/** `space` follows one Space; its readers are decided like the Spaces API, with one query for all of them. */
export const spacesLiveChannels = {
  space: {
    scope: z.object({ space: ResourceShortIdSchema }).strict(),
    keys: async ({ space }: { space: string }) => {
      const spaceId = await spacesPublicResources.resolvePublicId("spaces", space);
      return spaceId ? [spaceId] : null;
    },
    authorize: async (spaceId: string, viewers: readonly LiveViewer[]): Promise<ReadonlySet<string>> => {
      const permissions = await getActorsSpacePermissions(
        spaceId,
        viewers.map((viewer) => ({ actor: viewer.actor, subject: viewer.accessSubject })),
      );
      return new Set(viewers.filter((_, position) => hasPermission(permissions[position] ?? "none", "read")).map((viewer) => viewer.id));
    },
  },
};
