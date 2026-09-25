import { openSpotlightSearch, type PromptSearchItem, useLocale } from "@k2b/ui";
import { apiClient } from "../../api/client";
import type { MailAssignableUser } from "../../service/collaboration";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import { readApiError } from "./api-response";

export type MailAssigneeChoice = { assigneeUserId: string | null };

const avatarUrl = (user: Pick<MailAssignableUser, "id" | "avatarHash">): string | undefined =>
  user.avatarHash ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}` : undefined;

/**
 * Picks one assignee for the selected conversations of one mailbox. The two
 * quick choices come first; below them the mailbox's assignable users, searched
 * through the same endpoint the details panel uses.
 */
export const chooseMailAssignee = (params: { mailboxId: string; currentUserId: string }): Promise<MailAssigneeChoice | null> => {
  const t = mailWorkspaceMessages.resolve([useLocale()()]).t;
  const quickChoices = (query: string): PromptSearchItem<MailAssigneeChoice>[] => {
    const needle = query.trim().toLocaleLowerCase();
    return [
      { label: t.assignToMe, icon: "ti ti-user-check", value: { assigneeUserId: params.currentUserId } },
      { label: t.unassign, icon: "ti ti-user-off", value: { assigneeUserId: null } },
    ].filter((item) => !needle || item.label.toLocaleLowerCase().includes(needle));
  };
  const userItem = (user: MailAssignableUser): PromptSearchItem<MailAssigneeChoice> => ({
    label: user.displayName,
    desc: user.uid,
    icon: "ti ti-user",
    previewUrl: avatarUrl(user),
    value: { assigneeUserId: user.id },
  });
  const others = (users: readonly MailAssignableUser[]) => users.filter((user) => user.id !== params.currentUserId);

  return openSpotlightSearch<MailAssigneeChoice>({
    title: t.assignConversations,
    icon: "ti ti-user-plus",
    placeholder: t.searchPeople,
    minQueryLength: 0,
    noResultsText: t.noMatchingPeople,
    resolve: async ({ query, abortSignal }) => {
      const trimmed = query.trim();
      const response = await apiClient.mailboxes[":mailboxId"]["assignable-users"].$get(
        { param: { mailboxId: params.mailboxId }, query: { search: trimmed || undefined, limit: "50" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t.noMatchingPeople));
      return [...quickChoices(trimmed), ...others(await response.json()).map(userItem)];
    },
  }).then((selected) => selected?.value ?? null);
};
