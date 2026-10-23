import type { AccessSubject } from "@k2b/cloud/contracts";
import { hasPermission, type RequestActor } from "@k2b/cloud/server";
import type { SpaceItemAssignee, SpaceTaskChecklistEntry } from "@/contracts";
import { getActorsSpacePermissions } from "@/service/access";
import { spacesService } from "@/service/index";
import { resolvePublicId } from "@/service/public-resources";

/** One task or event as the mobile app shows it, with what the reader may change. */
export type PwaTask = {
  shortId: string;
  spaceShortId: string;
  spaceName: string;
  spaceColor: string;
  title: string;
  /** An event has a start; it has people and a place instead of a checklist. */
  event: boolean;
  completed: boolean;
  deadline: string | null;
  deadlineAllDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  people: SpaceItemAssignee[];
  /** Markdown. */
  description: string | null;
  /** Tasks only. */
  checklist: Pick<SpaceTaskChecklistEntry, "id" | "label" | "completed">[];
  /** The reader may check the task and its checklist off. */
  canWrite: boolean;
};

/**
 * The task `taskShortId` of the Space `spaceShortId`, read with the same Space permission as the API. Null when either
 * does not exist, the task belongs to another Space, or the reader may not read the Space, so an address never tells
 * a reader without access that the task exists.
 */
export async function loadPwaTask(params: {
  spaceShortId: string;
  taskShortId: string;
  actor: RequestActor;
  subject: AccessSubject;
}): Promise<PwaTask | null> {
  const [spaceId, itemId] = await Promise.all([resolvePublicId("spaces", params.spaceShortId), resolvePublicId("items", params.taskShortId)]);
  if (!spaceId || !itemId) return null;
  const [permission = "none"] = await getActorsSpacePermissions(spaceId, [{ actor: params.actor, subject: params.subject }]);
  if (!hasPermission(permission, "read")) return null;
  const [space, item] = await Promise.all([spacesService.space.get({ id: spaceId }), spacesService.item.get({ id: itemId })]);
  if (!space || !item || item.spaceId !== spaceId) return null;
  const event = Boolean(item.startsAt || item.endsAt);
  const checklist = event ? [] : await spacesService.item.checklist.list({ itemId });
  return {
    shortId: params.taskShortId,
    spaceShortId: params.spaceShortId,
    spaceName: space.name,
    spaceColor: space.color,
    title: item.title,
    event,
    completed: item.completedAt !== null,
    deadline: item.deadline,
    deadlineAllDay: item.deadlineAllDay,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    allDay: item.allDay,
    location: item.location,
    people: item.assignees ?? [],
    description: item.description,
    checklist: checklist.map(({ id, label, completed }) => ({ id, label, completed })),
    canWrite: hasPermission(permission, "write"),
  };
}
