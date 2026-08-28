import { Avatar, Combobox, type ComboboxOption, IconButton } from "@k2b/ui";
import { For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceItemAssignee } from "@/contracts";
import { useSpaceMessages } from "../../messages";

type SpaceAssigneePickerProps = {
  spaceId: string;
  value: () => SpaceItemAssignee[];
  onChange: (assignees: SpaceItemAssignee[]) => void;
  disabled?: boolean;
  placeholder?: string;
  variant?: "chips" | "rows";
};

const selectedIds = (assignees: SpaceItemAssignee[]) => assignees.map((assignee) => assignee.id);

const removeAssignee = (assignees: SpaceItemAssignee[], id: string) => assignees.filter((assignee) => assignee.id !== id);

type AssigneeOption = ComboboxOption & { avatarHash: string | null };

export default function SpaceAssigneePicker(props: SpaceAssigneePickerProps) {
  const t = useSpaceMessages();
  const variant = () => props.variant ?? "chips";
  const current = () => props.value();

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

  return (
    <div class="flex flex-col gap-2">
      <Show when={current().length > 0}>
        <Show
          when={variant() === "rows"}
          fallback={
            <div class="flex flex-wrap gap-2">
              <For each={current()}>
                {(assignee) => (
                  <span class="inline-flex items-center gap-1.5 rounded-full bg-[var(--ui-surface-muted)] px-2 py-1 text-xs">
                    <Avatar
                      name={assignee.displayName}
                      fallback={(assignee.displayName.trim() || "?").slice(0, 2).toUpperCase()}
                      src={
                        assignee.avatarHash
                          ? `/api/accounts/users/${encodeURIComponent(assignee.id)}/avatar?rev=${encodeURIComponent(assignee.avatarHash)}`
                          : undefined
                      }
                      size="xs"
                    />
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
            <For each={current()}>
              {(assignee) => (
                <div class="group flex items-center gap-2">
                  <Avatar
                    name={assignee.displayName}
                    fallback={(assignee.displayName.trim() || "?").slice(0, 2).toUpperCase()}
                    src={
                      assignee.avatarHash
                        ? `/api/accounts/users/${encodeURIComponent(assignee.id)}/avatar?rev=${encodeURIComponent(assignee.avatarHash)}`
                        : undefined
                    }
                    size="xs"
                  />
                  <div class="min-w-0 flex-1">
                    <span class="block truncate text-sm">{assignee.displayName}</span>
                  </div>
                  <Show when={!props.disabled}>
                    <IconButton
                      label={t.removeAssignee({ name: assignee.displayName })}
                      size="xs"
                      onClick={() => remove(assignee.id)}
                      class="text-zinc-400 opacity-0 transition-all hover:text-red-500 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                      title={t.removeAssignee({ name: assignee.displayName })}
                    >
                      <i class="ti ti-x text-sm" />
                    </IconButton>
                  </Show>
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
