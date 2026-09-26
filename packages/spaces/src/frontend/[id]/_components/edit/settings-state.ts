import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { User } from "@/contracts";
import { spacesService } from "@/service";
import { spacesPublicResources } from "@/service/public-resources";
import type { SpaceSettingsContext, SpaceUserSettings } from "@/settings-context";

export const loadSpaceSettingsContext = async (params: {
  user: Pick<User, "id">;
  spaceId: string;
  settings: SpaceUserSettings;
}): Promise<Result<SpaceSettingsContext>> => {
  const [existingSpace, permission] = await Promise.all([
    spacesService.space.get({ id: params.spaceId }),
    spacesService.space.permission.get({
      spaceId: params.spaceId,
      subject: { type: "user", userId: params.user.id },
    }),
  ]);

  if (!existingSpace) return fail(err.notFound("Space"));
  if (permission === "none") return fail(err.forbidden("Access denied"));

  const detail = await spacesService.space.getDetail({ id: params.spaceId });
  if (!detail) return fail(err.notFound("Space"));
  const [[space], columns, tags] = await Promise.all([
    spacesPublicResources.projectSpaces([detail]),
    spacesPublicResources.projectColumns(detail.columns),
    spacesPublicResources.projectTags(detail.tags),
  ]);
  if (!space) return fail(err.notFound("Space"));
  const publicDetail = { ...space, columns, tags };

  if (permission !== "admin") {
    return ok({
      space: publicDetail,
      settings: params.settings,
      permission,
      accessEntries: [],
      apiKeys: [],
      wormholes: [],
      githubTokenConfigured: false,
    });
  }

  const actor = spacesService.wormhole.actorForUser(params.user);
  const [access, apiKeys, wormholes, githubTokenConfigured] = await Promise.all([
    spacesService.access.list({ spaceId: params.spaceId }),
    spacesService.access.apiKeys.list({ spaceId: params.spaceId }),
    spacesService.wormhole.listConfigured({ sourceSpaceId: params.spaceId, actor }),
    spacesService.space.githubToken.has({ id: params.spaceId }),
  ]);
  if (!wormholes.ok) {
    return fail(wormholes.status === 403 ? err.forbidden(wormholes.error) : err.internal(wormholes.error));
  }

  return ok({
    space: publicDetail,
    settings: params.settings,
    permission,
    accessEntries: access.items,
    apiKeys,
    wormholes: await spacesPublicResources.projectWormholes(wormholes.data),
    githubTokenConfigured,
  });
};
