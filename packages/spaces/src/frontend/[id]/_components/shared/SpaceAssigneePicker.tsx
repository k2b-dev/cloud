import { type DateContext, dates } from "@k2b/stdlib";
import { Avatar, Combobox, type ComboboxOption, IconButton, StatusBadge } from "@k2b/ui";
import { For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceItemAssignee, SpaceItemClaim } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { AssigneeAvatar } from "./AssigneeAvatars";
import ClaimAvatar from "./claim/ClaimAvatar";
import { isClaimHolder } from "./claim/claim";

type SpaceAssigneePickerProps = {
  spaceId: string;
  value: () => SpaceItemAssignee[];
  onChange: (assignees: SpaceItemAssignee[]) => void;
  disabled?: boolean;
  placeholder?: string;
  variant?: "chips" | "rows";
  /**
   * Rows only: who works on the task. Working is a state of one assignee in the list: their row comes first and carries
   * the ring, the "working on it" badge, and the claim time.
   */
  claim?: SpaceItemClaim | null;
  currentUserId?: string;
  dateConfig?: DateContext;
};

const selectedIds = (assignees: SpaceItemAssignee[]) => assignees.map((assignee) => assignee.id);

const removeAssignee = (assignees: SpaceItemAssignee[], id: string) => assignees.filter((assignee) => assignee.id !== id);

export default function SpaceAssigneePicker(props: SpaceAssigneePickerProps) {
  const t = useSpaceMessages();
  const variant = () => props.variant ?? "chips";
  const current = () => props.value();
  const claim = () => (variant() === "rows" ? (props.claim ?? null) : null);
  const holder = () => current().find((assignee) => isClaimHolder(claim(), assignee));
  /** The working assignee first, so the account on the task stays in view; everyone else keeps their order. */
  const ordered = () => {
    const first = holder();
    return first ? [first, ...current().filter((assignee) => assignee !== first)] : current();
  };
  /** A claim whose holder is not among the assignees, which then still leads as a working row. */
  const unassignedHolder = () => (holder() ? null : claim());

  /**
   * The assignees behind the options on show. The combobox hands back only an option's ID and label, so the kind and
   * picture of the chosen person or service account come from here.
   */
  let shown = new Map<string, SpaceItemAssignee>();

  const fetchAssignableUsers = async (query: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    const res = await apiClient[":id"]["assignable-users"].$get(
      {
        param: { id: props.spaceId },
        query: {
          search: query,
          exclude_user_ids: selectedIds(current()).join(","),
        },
      },
      { init: { signal } },
    );
    if (!res.ok) throw new Error(t.loadAssigneesFailed);
    const users = await res.json();
    shown = new Map(
      users.map((user) => [user.id, { id: user.id, kind: user.kind, displayName: user.displayName, avatarHash: user.avatarHash }]),
    );
    return users.map((user) => ({
      id: user.id,
      label: user.displayName,
      description: user.description,
      icon: user.kind === "user" ? "ti ti-user" : "ti ti-api",
    }));
  };

  const addAssignee = (option: ComboboxOption) => {
    const assignee = shown.get(option.id);
    if (!assignee || current().some((entry) => entry.id === option.id)) return;
    props.onChange([...current(), assignee]);
  };

  const remove = (id: string) => props.onChange(removeAssignee(current(), id));

  /**
   * One person in the rows list. The working state stays inside the row's single line: the badge does not wrap and the
   * claim time gives way first, so a claim that starts or ends changes no row height. Only assignees can be removed.
   */
  const PersonRow = (row: { name: string; assignee?: SpaceItemAssignee; claim: SpaceItemClaim | null }) => (
    <div class="k2b-progressive-row flex items-center gap-2" data-spaces-assignee-row data-spaces-claim-holder={row.claim ? "" : undefined}>
      <Show when={row.claim} fallback={row.assignee ? <AssigneeAvatar assignee={row.assignee} /> : <Avatar name={row.name} size="xs" />}>
        {(working) => <ClaimAvatar claim={working()} currentUserId={props.currentUserId ?? ""} />}
      </Show>
      <span class="flex min-w-0 flex-1 items-center gap-1.5">
        <span class="min-w-0 truncate text-sm" title={row.name}>
          {row.name}
        </span>
        <Show when={row.claim}>
          {(working) => (
            <>
              {/* The label says in words what the ring shows, so it does not depend on seeing color. */}
              <StatusBadge tone="ok" icon={null} label={t.workingOnIt} class="shrink-0" />
              {/*
               * The claim time shows whole or not at all: the empty inline block before it is a line break opportunity,
               * so a time that does not fit moves to a second line that the one-line box clips, instead of a cut-off
               * date. Screen readers still read it.
               */}
              <span class="h-4 min-w-0 flex-1 overflow-hidden text-xs leading-4 text-dimmed">
                <span class="inline-block" />
                <span class="inline-block whitespace-nowrap">
                  {t.claimedSince}{" "}
                  <time datetime={working().claimedAt} title={dates.formatDateTime(working().claimedAt, props.dateConfig)}>
                    {dates.formatDateRelative(working().claimedAt, props.dateConfig)}
                  </time>
                </span>
              </span>
            </>
          )}
        </Show>
      </span>
      <Show when={!props.disabled && row.assignee}>
        {(assignee) => (
          <IconButton
            label={t.removeAssignee({ name: assignee().displayName })}
            size="xs"
            onClick={() => remove(assignee().id)}
            class="k2b-progressive-action text-dimmed hover:text-red-500"
            title={t.removeAssignee({ name: assignee().displayName })}
          >
            <i class="ti ti-x text-sm" />
          </IconButton>
        )}
      </Show>
    </div>
  );

  return (
    <div class="flex flex-col gap-2">
      <Show when={current().length > 0 || claim()}>
        <Show
          when={variant() === "rows"}
          fallback={
            <div class="flex flex-wrap gap-2">
              <For each={current()}>
                {(assignee) => (
                  <span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--ui-surface-muted)] px-2 py-1 text-xs">
                    <AssigneeAvatar assignee={assignee} />
                    <span>{assignee.displayName}</span>
                    <Show when={!props.disabled}>
                      <IconButton
                        label={t.removeAssignee({ name: assignee.displayName })}
                        size="xs"
                        onClick={() => remove(assignee.id)}
                        class="text-dimmed hover:text-red-500"
                      >
                        <i class="ti ti-x text-xs" />
                      </IconButton>
                    </Show>
                  </span>
                )}
              </For>
            </div>
          }
        >
          <div class="flex flex-col gap-1">
            {/* A claim holder outside the assignees (a personal automation key, or a deleted account's claim) still leads. */}
            <Show when={unassignedHolder()}>{(holder) => <PersonRow name={holder().displayName} claim={holder()} />}</Show>
            <For each={ordered()}>
              {(assignee) => (
                <PersonRow name={assignee.displayName} assignee={assignee} claim={isClaimHolder(claim(), assignee) ? claim() : null} />
              )}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={!props.disabled}>
        <Combobox
          aria-label={t.addAssignee}
          placeholder={props.placeholder ?? t.searchPeople}
          fetchData={fetchAssignableUsers}
          onSelect={addAssignee}
        />
      </Show>
    </div>
  );
}
