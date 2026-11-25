import { mutation as mutations } from "@k2b/stdlib/solid";
import { Bar, Button, Check, Field, Input, Popover, Row, Section, Text, useToast } from "@k2b/ui/v2";
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
  const toast = useToast();
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
    onError: (error) => toast(error.message, { status: "bad" }),
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
    onError: (error) => toast(error.message, { status: "bad" }),
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
    onError: (error) => toast(error.message, { status: "bad" }),
  });

  const commitLabel = (entry: SpaceTaskChecklistEntry, value: string) => {
    const label = value.trim();
    if (!label || label === entry.label) return;
    updateEntry.mutate({ id: entry.id, label });
  };
  const add = (value: string) => {
    const label = value.trim();
    if (label && !createEntry.loading()) createEntry.mutate(label);
  };
  const busy = () => updateEntry.loading() || deleteEntry.loading();
  const [draft, setDraft] = createSignal<Record<string, string>>({});
  const done = () => entries().filter((entry) => entry.completed).length;

  return (
    <Section icon="checklist" title={t.checklist} count={entries().length ? `${done()}/${entries().length}` : undefined}>
      <Show when={entries().length > 0 || props.canWrite} fallback={<Text type="meta">{t.noChecklistEntries}</Text>}>
        <For each={entries()}>
          {(entry) => (
            <Row
              lines={[entry.label]}
              end={
                <>
                  <Check
                    label={
                      entry.completed ? t.markChecklistIncomplete({ label: entry.label }) : t.markChecklistComplete({ label: entry.label })
                    }
                    checked={entry.completed}
                    disabled={!props.canWrite || busy()}
                    onChange={(completed) => updateEntry.mutate({ id: entry.id, completed })}
                  />
                  <Show when={props.canWrite}>
                    <Popover
                      variant="ghost"
                      icon="pencil"
                      label={t.checklistEntryLabel}
                      title={t.checklistEntryLabel}
                      content={
                        <>
                          <Field label={t.checklistEntryLabel} name={`checklist-${entry.id}`}>
                            <Input
                              value={draft()[entry.id] ?? entry.label}
                              disabled={busy()}
                              onInput={(value) => setDraft((current) => ({ ...current, [entry.id]: value }))}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.isComposing) commitLabel(entry, draft()[entry.id] ?? entry.label);
                              }}
                            />
                          </Field>
                          <Bar
                            end={
                              <>
                                <Button icon="trash" disabled={busy()} onClick={() => deleteEntry.mutate(entry.id)}>
                                  {t.deleteChecklistEntry({ label: entry.label })}
                                </Button>
                                <Button busy={updateEntry.loading()} onClick={() => commitLabel(entry, draft()[entry.id] ?? entry.label)}>
                                  {t.save}
                                </Button>
                              </>
                            }
                          />
                        </>
                      }
                    />
                  </Show>
                </>
              }
            />
          )}
        </For>
        <Show when={props.canWrite}>
          <Field label={t.addChecklistEntry} name="checklist-new">
            <Input
              value={newLabel()}
              placeholder={t.addChecklistEntry}
              disabled={createEntry.loading()}
              onInput={setNewLabel}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.isComposing) add(newLabel());
              }}
            />
          </Field>
        </Show>
      </Show>
    </Section>
  );
}
