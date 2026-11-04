import type { MailAssignableUser } from "../../service/collaboration";

/**
 * Someone responsible for a row's conversation, as the columns view draws them. `unknown` marks someone the reader may
 * not list, shown with a placeholder name and a gray face.
 */
export type MailRowAssignee = { id: string; name: string; src?: string; unknown?: true };

const avatarUrl = (user: Pick<MailAssignableUser, "id" | "avatarHash">): string | undefined =>
  user.avatarHash ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}` : undefined;

/**
 * The people responsible for a row, named from the mailbox's assignable people the reader may list. Anyone else keeps
 * the placeholder name and no picture, so a row never shows more about a person than the reader may see.
 */
export const mailRowAssignees = (
  userIds: readonly string[],
  users: readonly Pick<MailAssignableUser, "id" | "displayName" | "avatarHash">[],
  unknownName: string,
): MailRowAssignee[] =>
  userIds.map((id) => {
    const user = users.find((candidate) => candidate.id === id);
    return user ? { id, name: user.displayName, src: avatarUrl(user) } : { id, name: unknownName, unknown: true };
  });

/** You first, as "You", then the others in their order: the face and name show the first, "+n" counts the rest. */
export const mailRowAssigneeLabels = (
  assignees: readonly MailRowAssignee[],
  currentUserId: string | null,
  you: string,
): MailRowAssignee[] => {
  const self = assignees.filter((assignee) => assignee.id === currentUserId).map((assignee) => ({ ...assignee, name: you }));
  return [...self, ...assignees.filter((assignee) => assignee.id !== currentUserId)];
};
