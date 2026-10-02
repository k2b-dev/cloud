import { type DateContext, dates } from "@k2b/stdlib";
import { Avatar, Combobox, type ComboboxOption, IconButton, StatusBadge } from "@k2b/ui";
import { For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceItemAssignee, SpaceItemClaim } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import ClaimAvatar from "./claim/ClaimAvatar";

type SpaceAssigneePickerProps = {
  spaceId: string;
  value: () => SpaceItemAssignee[];
  onChange: (assignees: SpaceItemAssignee[]) => void;
  disabled?: boolean;
  placeholder?: string;
  variant?: "chips" | "rows";
  /** Rows only: the claim holder leads the list with its success ring and claim time, and appears once. */
  claim?: SpaceItemClaim | null;
  currentUserId?: string;
  dateConfig?: DateContext;
};

const selectedIds = (assignees: SpaceItemAssignee[]) => assignees.map((assignee) => assignee.id);

const removeAssignee = (assignees: SpaceItemAssignee[], id: string) => assignees.filter((assignee) => assignee.id !== id);

type AssigneeOption = ComboboxOption & { avatarHash: string | null };

const avatarSrc = (assignee: SpaceItemAssignee) =>
  assignee.avatarHash
    ? `/api/accounts/users/${encodeURIComponent(assignee.id)}/avatar?rev=${encodeURIComponent(assignee.avatarHash)}`
    : undefined;

export default function SpaceAssigneePicker(props: SpaceAssigneePickerProps) {
  const t = useSpaceMessages();
  const variant = () => props.variant ?? "chips";
  const current = () => props.value();
  const claim = () => (variant() === "rows" ? (props.claim ?? null) : null);
  const holderId = () => {
    const actor = claim()?.actor;
    return actor?.kind === "user" ? actor.id : null;
  };
  /** The holder's own assignee entry, when the holder is also assigned. */
  const assignedHolder = () => current().find((assignee) => assignee.id === holderId());
  const others = () => current().filter((assignee) => assignee.id !== holderId());

  const fetchAssignableUsers = async (query: string, signal: AbortSignal): Promise<AssigneeOption[]> => {
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
    return users.map((user) => ({
      id: user.id,
      label: user.displayName,
      avatarHash: user.avatarHash,
      description: user.description,
      icon: "ti ti-user",
    }));
  };

  const addAssignee = (option: ComboboxOption) => {
    if (current().some((assignee) => assignee.id === option.id)) return;
    props.onChange([...current(), { id: option.id, displayName: option.label, avatarHash: (option as AssigneeOption).avatarHash ?? null }]);
  };

  const remove = (id: string) => props.onChange(removeAssignee(current(), id));

  const rowRemoveButton = (assignee: SpaceItemAssignee) => (
    <Show when={!props.disabled}>
      <IconButton
        label={t.removeAssignee({ name: assignee.displayName })}
        size="xs"
        onClick={() => remove(assignee.id)}
        class="text-zinc-400 opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
        title={t.removeAssignee({ name: assignee.displayName })}
      >
        <i class="ti ti-x text-sm" />
      </IconButton>
    </Show>
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
                    <Avatar name={assignee.displayName} src={avatarSrc(assignee)} size="xs" />
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
            <Show when={claim()}>
              {(holder) => (
                <div class="group flex items-center gap-2" data-spaces-claim-holder>
                  <ClaimAvatar claim={holder()} currentUserId={props.currentUserId ?? ""} />
                  <div class="min-w-0 flex-1">
                    {/* The label says in words what the ring shows, so it does not depend on seeing color. */}
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="truncate text-sm">{holder().displayName}</span>
                      <StatusBadge tone="ok" icon={null} label={t.workingOnIt} class="shrink-0" />
                    </span>
                    {/* Wraps instead of truncating so the "not assigned" marker stays readable in a narrow panel. */}
                    <span class="block text-xs text-dimmed">
                      {t.claimedSince}{" "}
                      <time class="whitespace-nowrap" datetime={holder().claimedAt}>
                        {dates.formatDateTime(holder().claimedAt, props.dateConfig)}
                      </time>
                      <Show when={!assignedHolder()}>
                        {" "}
                        <span class="whitespace-nowrap">· {t.claimNotAssigned}</span>
                      </Show>
                    </span>
                  </div>
                  <Show when={assignedHolder()}>{(assignee) => rowRemoveButton(assignee())}</Show>
                </div>
              )}
            </Show>
            <For each={others()}>
              {(assignee) => (
                <div class="group flex items-center gap-2">
                  <Avatar name={assignee.displayName} src={avatarSrc(assignee)} size="xs" />
                  <div class="min-w-0 flex-1">
                    <span class="block truncate text-sm">{assignee.displayName}</span>
                  </div>
                  {rowRemoveButton(assignee)}
                </div>
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
