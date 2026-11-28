import { query } from "@k2b/stdlib/solid";
import { createSignal, createUniqueId } from "solid-js";
import type { EntityListItem, PaginationResponse } from "../contracts/shared";

/** Members per request. Further pages load only when the viewer asks for them. */
export const PAGE_SIZE = 20;
export type GroupMember = Exclude<EntityListItem, { kind: "group" }>;

type MembersPage =
  /** The directory withholds group members from this viewer (guest accounts). */
  | { visible: false; directoryGroup: boolean }
  | { visible: true; directoryGroup: boolean; members: GroupMember[]; total: number; page: number; hasNext: boolean };

/** Reads the Accounts directory with the viewer's own visibility: `null` when it is withheld. */
const listEntities = async (params: Record<string, string>, signal: AbortSignal) => {
  const url = new URL("/api/accounts/entities", window.location.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
  const data: { items: EntityListItem[]; pagination: PaginationResponse } = await response.json();
  return data;
};

/**
 * Who currently receives access through a group grant: direct members and
 * members of nested groups, as access resolution counts them. Loading starts
 * when the row mounts in the browser, so the list usually opens complete
 * instead of growing after the viewer expands it.
 */
export const createGroupCoverage = (groupId: string) => {
  const [open, setOpen] = createSignal(false);
  const members = query.createInfinite<string, MembersPage, number>({
    source: () => groupId,
    loadPage: async (id, { cursor, abortSignal }) => {
      const page = cursor ?? 1;
      const [list, group] = await Promise.all([
        listEntities(
          { kinds: "user,service_account", member_of_group_id: id, recursive: "true", page: String(page), per_page: String(PAGE_SIZE) },
          abortSignal,
        ),
        // Only the first page needs the group itself, for the directory hint.
        page === 1 ? listEntities({ kinds: "group", group_ids: id, per_page: "1" }, abortSignal) : null,
      ]);
      const directoryGroup = group?.items.some((item) => item.kind === "group" && item.group.provider === "ipa") ?? false;
      if (!list) return { visible: false, directoryGroup };
      return {
        visible: true,
        directoryGroup,
        members: list.items.filter((item) => item.kind !== "group"),
        total: list.pagination.total,
        page,
        hasNext: list.pagination.has_next,
      };
    },
    getNextCursor: (page) => (page.visible && page.hasNext ? page.page + 1 : null),
  });
  return { open, setOpen, panelId: createUniqueId(), members };
};

export type GroupCoverage = ReturnType<typeof createGroupCoverage>;
