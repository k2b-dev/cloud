import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, IconButton, prompts, SettingsCollection, SettingsGroup, toast } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceColumn } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { NameColorForm } from "./NameColorForm";
import { readErrorMessage } from "./utils";

export function StatusesSection(props: {
  spaceId: string;
  columns: SpaceColumn[];
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const m = useSpaceMessages();
  const [optimisticColumns, setOptimisticColumns] = createSignal<SpaceColumn[] | null>(null);
  const columns = () => optimisticColumns() ?? props.columns;
  const [editingId, setEditingId] = createSignal<string | "new" | null>(null);
  const reconcile = () => void props.onSettingsChange?.().catch((error) => prompts.error(error.message));

  createEffect(() => props.onDirtyChange(editingId() !== null));
  onCleanup(() => props.onDirtyChange(false));

  const createMut = mutations.create({
    mutation: async (data: { name: string; color?: string }) => {
      const res = await apiClient[":id"].columns.$post({
        param: { id: props.spaceId },
        json: data,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.createStatusFailed));
      }
      return res.json();
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success(m.statusCreated);
      props.onWorkspaceChange?.();
      reconcile();
    },
    onError: (err) => prompts.error(err.message),
  });

  const updateMut = mutations.create({
    mutation: async (data: { id: string; name: string; color: string | null }) => {
      const res = await apiClient[":id"].columns[":columnId"].$patch({
        param: { id: props.spaceId, columnId: data.id },
        json: { name: data.name, color: data.color },
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.updateStatusFailed));
      }
      return res.json();
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success(m.statusUpdated);
      props.onWorkspaceChange?.();
      reconcile();
    },
    onError: (err) => prompts.error(err.message),
  });

  const deleteMut = mutations.create<SpaceColumn, SpaceColumn>({
    mutation: async (column: SpaceColumn) => {
      const res = await apiClient[":id"].columns[":columnId"].$delete({
        param: { id: props.spaceId, columnId: column.id },
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.deleteStatusFailed));
      }
      return column;
    },
    onSuccess: () => {
      toast.success(m.statusDeleted);
      props.onWorkspaceChange?.();
      reconcile();
    },
    onError: (err) => prompts.error(err.message),
  });

  type ReorderIntent = { columnIds: string[] };
  const reorderMut = mutations.create<void, ReorderIntent>({
    mutation: async ({ columnIds }) => {
      const res = await apiClient[":id"].columns.order.$put({
        param: { id: props.spaceId },
        json: { columnIds },
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.reorderStatusesFailed));
      }
    },
    onSuccess: () => {
      props.onWorkspaceChange?.();
      const refresh = props.onSettingsChange?.();
      if (!refresh) {
        setOptimisticColumns(null);
        return;
      }
      void refresh.catch((error) => prompts.error(error.message)).finally(() => setOptimisticColumns(null));
    },
    onError: (err) => {
      setOptimisticColumns(null);
      prompts.error(err.message);
    },
    onAbort: () => setOptimisticColumns(null),
  });
  let reorderSubmitting = false;
  let deletePromptPending = false;
  const deleteColumn = async (column: SpaceColumn) => {
    if (deletePromptPending || deleteMut.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await prompts.confirm(m.deleteStatusConfirm({ name: column.name }), {
        title: m.deleteStatus,
        variant: "danger",
      });
      if (confirmed) await deleteMut.mutate(column);
    } finally {
      deletePromptPending = false;
    }
  };

  const moveColumn = (index: number, direction: -1 | 1) => {
    if (reorderSubmitting || reorderMut.loading()) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= columns().length) return;

    const previous = columns();
    const newColumns = [...previous];
    const [moved] = newColumns.splice(index, 1);
    newColumns.splice(newIndex, 0, moved!);
    setOptimisticColumns(newColumns);

    reorderSubmitting = true;
    void reorderMut.mutate({ columnIds: newColumns.map((c) => c.id) }).finally(() => (reorderSubmitting = false));
  };

  return (
    <>
      <Show when={editingId()}>
        {(id) => {
          const column = () => columns().find((item) => item.id === id());
          return (
            <SettingsGroup
              title={id() === "new" ? m.newStatus : column() ? m.editStatus({ name: column()!.name }) : m.editGenericStatus}
              description={m.statusFormDescription}
            >
              <NameColorForm
                mode={id() === "new" ? "create" : "edit"}
                initialName={column()?.name}
                initialColor={column()?.color}
                nameLabel={m.name}
                namePlaceholder={m.statusNamePlaceholder}
                createLabel={m.createStatus}
                onSave={(data) => {
                  const current = column();
                  if (id() === "new") createMut.mutate(data);
                  else if (current) updateMut.mutate({ id: current.id, name: data.name, color: data.color ?? null });
                }}
                onCancel={() => setEditingId(null)}
                loading={createMut.loading() || updateMut.loading()}
              />
            </SettingsGroup>
          );
        }}
      </Show>

      <SettingsCollection title={m.workflowStatuses} description={m.workflowStatusesDescription} empty={m.noStatuses}>
        <SettingsCollection.Action>
          <Button type="button" size="sm" disabled={editingId() !== null} onClick={() => setEditingId("new")}>
            <i class="ti ti-plus" aria-hidden="true" />
            {m.newStatus}
          </Button>
        </SettingsCollection.Action>
        <For each={columns()}>
          {(column, index) => (
            <SettingsCollection.Item
              title={column.name}
              description={m.positionOf({ position: index() + 1, count: columns().length })}
              icon={<span class="h-3 w-3 rounded-full" style={`background-color:${column.color || "#6b7280"}`} />}
            >
              <SettingsCollection.Item.Actions>
                <SettingsCollection.Item.Reorder
                  label={column.name}
                  index={index()}
                  count={columns().length}
                  disabled={reorderMut.loading()}
                  onMove={(direction) => moveColumn(index(), direction)}
                />
                <IconButton
                  label={m.editNamedStatus({ name: column.name })}
                  size="sm"
                  onClick={() => setEditingId(column.id)}
                  title={m.editGenericStatus}
                >
                  <i class="ti ti-pencil" aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={m.deleteNamedStatus({ name: column.name })}
                  size="sm"
                  onClick={() => void deleteColumn(column)}
                  title={m.deleteStatus}
                >
                  <i class="ti ti-trash" aria-hidden="true" />
                </IconButton>
              </SettingsCollection.Item.Actions>
            </SettingsCollection.Item>
          )}
        </For>
      </SettingsCollection>
    </>
  );
}
