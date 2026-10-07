import { query } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { CloudAvatar } from "../account/Avatar";
import type { BaseUser, EntityListItem, PaginationResponse } from "../contracts/shared";
import { accessMessages } from "./messages";

/** Members per request. Further pages load only when the viewer asks for them. */
const PAGE_SIZE = 20;

type MembersPage =
  /** The directory withholds group members from this viewer (guest accounts). */
  | { visible: false; directoryGroup: boolean }
  | { visible: true; directoryGroup: boolean; members: BaseUser[]; total: number; page: number; hasNext: boolean };

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
          { kinds: "user", member_of_group_id: id, recursive: "true", page: String(page), per_page: String(PAGE_SIZE) },
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
        members: list.items.flatMap((item) => (item.kind === "user" ? [item.user] : [])),
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

const firstPage = (coverage: GroupCoverage) => coverage.members.pages()[0];

/**
 * The members toggle beside the group name. Its label never changes, so
 * loading the members moves nothing in the row; the count leads the list.
 */
export function GroupCoverageToggle(props: { coverage: GroupCoverage; groupName: string }) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  return (
    <button
      type="button"
      aria-expanded={props.coverage.open()}
      aria-controls={props.coverage.panelId}
      // The group name tells several group rows apart.
      aria-label={t().groupMembersOf({ name: props.groupName })}
      onClick={() => props.coverage.setOpen(!props.coverage.open())}
      // The size sits on the children: the scoped button normalization resets the button's own font.
      class="focus-ui flex items-center gap-0.5 self-center rounded text-dimmed transition-colors hover:text-secondary"
    >
      <span class="text-xs">{t().groupMembers}</span>
      <i
        class="ti ti-chevron-down shrink-0 text-[10px] transition-transform motion-reduce:transition-none"
        classList={{ "rotate-180": props.coverage.open() }}
        aria-hidden="true"
      />
    </button>
  );
}

/** The expanded member list. It stays in the document while collapsed so `aria-controls` always resolves. */
export function GroupCoveragePanel(props: { coverage: GroupCoverage; groupName: string }) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const members = () => props.coverage.members;
  const shown = () =>
    members()
      .pages()
      .flatMap((page) => (page.visible ? page.members : []));
  const total = () => {
    const page = firstPage(props.coverage);
    return page?.visible ? page.total : null;
  };
  const remaining = () => Math.max((total() ?? 0) - shown().length, 0);
  let panel: HTMLDivElement | undefined;
  let list: HTMLUListElement | undefined;
  let more: HTMLButtonElement | undefined;
  let retry: HTMLButtonElement | undefined;
  // A loading button is disabled, which drops keyboard focus, and the buttons leave on a failure or once
  // everything is shown. Unless the viewer has moved on, focus continues where they can act next.
  const settleFocus = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !panel?.contains(active)) return;
    const next = members().error() ? retry : members().hasMore() ? more : list;
    if (next?.isConnected) next.focus();
  };
  const showMore = async () => {
    await members().loadMore();
    settleFocus();
  };
  const tryAgain = async () => {
    await members().refresh();
    settleFocus();
  };

  return (
    // Indented to the name column: avatar (1.75rem) plus the row gap (0.5rem).
    <div ref={panel} id={props.coverage.panelId} hidden={!props.coverage.open()} class="flex flex-col gap-2 pb-2 pl-9">
      <Show when={members().pages().length === 0 && !members().error()}>
        <InlineGuidance loading>{t().groupMembersLoading}</InlineGuidance>
      </Show>
      <Show when={firstPage(props.coverage)?.visible === false}>
        <InlineGuidance icon="ti ti-eye-off">{t().groupMembersHidden}</InlineGuidance>
      </Show>
      <Show when={total() !== null}>
        <p class="text-sm text-dimmed">{t().groupMemberCount({ count: total() ?? 0 })}</p>
      </Show>
      <Show when={firstPage(props.coverage)?.directoryGroup}>
        <InlineGuidance icon="ti ti-info-circle">{t().directoryGroupHint}</InlineGuidance>
      </Show>
      <Show when={shown().length > 0}>
        <ul ref={list} tabindex="-1" aria-label={t().groupMembersOf({ name: props.groupName })} class="flex flex-col gap-1 outline-none">
          <For each={shown()}>
            {(user) => {
              const name = user.displayName || user.mail || user.uid;
              return (
                <li class="flex min-w-0 items-center gap-2 text-sm">
                  <CloudAvatar username={name} userId={user.id} avatarHash={user.avatarHash} size="xs" class="h-6 w-6 shrink-0" />
                  <span class="truncate">{name}</span>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={members().error()}>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
          <span>{t().groupMembersFailed}</span>{" "}
          <Button ref={retry} variant="text" size="xs" onClick={() => void tryAgain()}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={members().hasMore() && !members().error()}>
        <Button ref={more} variant="text" size="xs" class="self-start" loading={members().loadingMore()} onClick={() => void showMore()}>
          {t().showMoreMembers({ count: Math.min(remaining(), PAGE_SIZE) })}
        </Button>
      </Show>
    </div>
  );
}
