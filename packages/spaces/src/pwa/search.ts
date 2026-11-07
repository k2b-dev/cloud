import type { OverviewWork } from "@/overview-contracts";
import { spacesService } from "@/service/index";
import { spacesPublicResources } from "@/service/public-resources";

/** As many matches as the Spotlight of the web overview shows. */
const SEARCH_LIMIT = 20;

/**
 * Open tasks in every Space the person may read whose title or description contains `query`, as rows of "My tasks",
 * with the same permission-filtered search as the web overview's Spotlight.
 */
export async function searchPwaWork(params: { userId: string; query: string }): Promise<OverviewWork["items"]> {
  const subject = { type: "user" as const, userId: params.userId };
  const [hits, readable, writable] = await Promise.all([
    spacesService.item.searchAcross({ subject, query: params.query, kinds: "task", status: "open", limit: SEARCH_LIMIT }),
    spacesService.space.list({ subject }),
    spacesService.space.list({ subject, requiredLevel: "write" }),
  ]);
  const writableIds = new Set(writable.items.map((space) => space.id));
  const [items, spaces] = await Promise.all([
    spacesPublicResources.projectItems(hits.map((hit) => hit.item)),
    spacesPublicResources.projectSpaces(readable.items),
  ]);
  const spaceOf = new Map(readable.items.map((space, index) => [space.id, { shortId: spaces[index]!.id, color: space.color }]));
  return hits.flatMap((hit, index) => {
    const space = spaceOf.get(hit.item.spaceId);
    const item = items[index]!;
    if (!space) return [];
    return [
      {
        shortId: item.id,
        spaceShortId: space.shortId,
        spaceName: hit.space.name,
        spaceColor: space.color,
        title: item.title,
        priority: item.priority,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        deadline: item.deadline,
        deadlineAllDay: item.deadlineAllDay,
        canWrite: writableIds.has(hit.item.spaceId),
      },
    ];
  });
}
