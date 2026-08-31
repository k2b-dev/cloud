import { mutation as mutations } from "@k2b/stdlib/solid";
import { Checkbox, IconButton, prompts } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceTaskChecklistEntry } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";

type Props = {
  spaceId: string;
  itemId: string;
  entries: SpaceTaskChecklistEntry[];
  canWrite: boolean;
  onChanged: () => void;
};

export default function TaskChecklistSection(props: Props) {
  const t = useSpaceMessages();
  const [entries, setEntries] = createSignal([...props.entries]);
  const [newLabel, setNewLabel] = createSignal("");
  let currentItemId = props.itemId;

  createEffect(() => {
    const snapshot = { itemId: props.itemId, entries: props.entries };
    setEntries([...snapshot.entries]);
    if (snapshot.itemId !== currentItemId) {
      currentItemId = snapshot.itemId;
      setNewLabel("");
    }
  });

  const createEntry = mutations.create<SpaceTaskChecklistEntry, string>({
    mutation: async (label) => {
      const response = await apiClient[":id"].items[":itemId"].checklist.$post({
        param: { id: props.spaceId, itemId: props.itemId },
        json: { label },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.checklistCreateFailed));
      return response.json();
    },
    onSuccess: (entry) => {
      setEntries((current) => [...current, entry]);
      setNewLabel("");
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const updateEntry = mutations.create<SpaceTaskChecklistEntry, { id: string; label?: string; completed?: boolean }>({
    mutation: async ({ id, ...json }) => {
      const response = await apiClient[":id"].items[":itemId"].checklist[":entryId"].$patch({
        param: { id: props.spaceId, itemId: props.itemId, entryId: id },
        json,
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.checklistUpdateFailed));
      return response.json();
    },
    onSuccess: (entry) => {
      setEntries((current) => current.map((candidate) => (candidate.id === entry.id ? entry : candidate)));
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const deleteEntry = mutations.create<string, string>({
    mutation: async (id) => {
      const response = await apiClient[":id"].items[":itemId"].checklist[":entryId"].$delete({
        param: { id: props.spaceId, itemId: props.itemId, entryId: id },
      });
      if (!response.ok) throw new Error(await readResponseError(response, t.checklistDeleteFailed));
      return id;
    },
    onSuccess: (id) => {
      setEntries((current) => current.filter((entry) => entry.id !== id));
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const label = newLabel().trim();
    if (label && !createEntry.loading()) createEntry.mutate(label);
  };

  const commitLabel = (entry: SpaceTaskChecklistEntry, value: string) => {
    const label = value.trim();
    if (!label || label === entry.label) return;
    updateEntry.mutate({ id: entry.id, label });
  };

  return (
    <div class="flex flex-col gap-1.5">
      <Show when={entries().length > 0} fallback={!props.canWrite ? <p class="text-xs text-dimmed">{t.noChecklistEntries}</p> : undefined}>
        <ul class="flex flex-col gap-1">
          <For each={entries()}>
            {(entry) => (
              <li class="group/checklist flex min-w-0 items-center gap-2 rounded-[var(--ui-radius-control)] px-1 py-0.5 hover:bg-[var(--ui-hover)]">
                <Checkbox
                  aria-label={
                    entry.completed ? t.markChecklistIncomplete({ label: entry.label }) : t.markChecklistComplete({ label: entry.label })
                  }
                  value={entry.completed}
                  disabled={!props.canWrite || updateEntry.loading() || deleteEntry.loading()}
                  onValueChange={(completed) => updateEntry.mutate({ id: entry.id, completed })}
                />
                <input
                  type="text"
                  value={entry.label}
                  readOnly={!props.canWrite}
                  disabled={updateEntry.loading() || deleteEntry.loading()}
                  aria-label={t.checklistEntryLabel}
                  class={`focus-ui min-w-0 flex-1 rounded bg-transparent px-1 py-1 text-sm ${entry.completed ? "text-dimmed line-through" : "text-secondary"}`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      event.currentTarget.value = entry.label;
                      event.currentTarget.blur();
                    }
                  }}
                  onBlur={(event) => {
                    if (!event.currentTarget.value.trim()) event.currentTarget.value = entry.label;
                    else commitLabel(entry, event.currentTarget.value);
                  }}
                />
                <Show when={props.canWrite}>
                  <IconButton
                    label={t.deleteChecklistEntry({ label: entry.label })}
                    size="xs"
                    disabled={updateEntry.loading() || deleteEntry.loading()}
                    class="h-6 w-6 shrink-0 text-dimmed opacity-0 transition-opacity hover:text-red-600 group-hover/checklist:opacity-100 group-focus-within/checklist:opacity-100"
                    onClick={() => deleteEntry.mutate(entry.id)}
                  >
                    <i class="ti ti-trash text-xs" aria-hidden="true" />
                  </IconButton>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.canWrite}>
        <form class="flex items-center gap-2 px-1" onSubmit={submit}>
          <span class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed" aria-hidden="true">
            <i class="ti ti-plus text-sm" />
          </span>
          <input
            type="text"
            value={newLabel()}
            onInput={(event) => setNewLabel(event.currentTarget.value)}
            placeholder={t.addChecklistEntry}
            aria-label={t.addChecklistEntry}
            maxlength={500}
            disabled={createEntry.loading()}
            class="focus-ui min-w-0 flex-1 rounded bg-transparent px-1 py-1.5 text-sm text-secondary placeholder:text-dimmed"
          />
          <button type="submit" class="sr-only" disabled={!newLabel().trim() || createEntry.loading()}>
            {t.addChecklistEntry}
          </button>
        </form>
      </Show>
    </div>
  );
}
