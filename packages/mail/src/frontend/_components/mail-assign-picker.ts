import { openSpotlightSearch, type PromptSearchItem, useLocale } from "@k2b/ui";
import { apiClient } from "../../api/client";
import type { MailAssignableUser } from "../../service/collaboration";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import { readApiError } from "./api-response";

/** One change to the assignees of the selected conversations; `name` labels another person in feedback, null is you. */
export type MailAssigneeChoice =
  | { mode: "add" | "remove"; userId: string; name: string | null }
  | { mode: "replace"; userId: null; name: null };

const avatarUrl = (user: Pick<MailAssignableUser, "id" | "avatarHash">): string | undefined =>
  user.avatarHash ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}` : undefined;

/**
 * Picks one change to the assignees of the selected conversations of one mailbox: add yourself,
 * remove yourself, or remove everyone first, then add any assignable person, searched through the
 * same endpoint the details panel uses. A conversation keeps its other assignees.
 */
export const chooseMailAssignee = (params: { mailboxId: string; currentUserId: string }): Promise<MailAssigneeChoice | null> => {
  const t = mailWorkspaceMessages.resolve([useLocale()()]).t;
  const quickChoices = (query: string): PromptSearchItem<MailAssigneeChoice>[] => {
    const needle = query.trim().toLocaleLowerCase();
    const items: PromptSearchItem<MailAssigneeChoice>[] = [
      { label: t.assignToMe, icon: "ti ti-user-check", value: { mode: "add", userId: params.currentUserId, name: null } },
      { label: t.removeMe, icon: "ti ti-user-minus", value: { mode: "remove", userId: params.currentUserId, name: null } },
      { label: t.unassign, icon: "ti ti-user-off", value: { mode: "replace", userId: null, name: null } },
    ];
    return items.filter((item) => !needle || item.label.toLocaleLowerCase().includes(needle));
  };
  const userItem = (user: MailAssignableUser): PromptSearchItem<MailAssigneeChoice> => ({
    label: user.displayName,
    desc: user.uid,
    icon: "ti ti-user",
    previewUrl: avatarUrl(user),
    value: { mode: "add", userId: user.id, name: user.displayName },
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
