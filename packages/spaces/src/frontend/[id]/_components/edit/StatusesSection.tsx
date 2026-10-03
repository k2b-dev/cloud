import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, IconButton, prompts, SettingsCollection, SettingsGroup, Switch } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type BoardColumn, boardColumnOrderId, orderBoardColumns } from "@/board-columns";
import type { SpaceColumn, SpaceVirtualColumn, SpaceVirtualColumnKind } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { NameColorForm } from "./NameColorForm";
import { readErrorMessage } from "./utils";

export function StatusesSection(props: {
  spaceId: string;
  columns: SpaceColumn[];
  virtualColumns: SpaceVirtualColumn[];
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const m = useSpaceMessages();
  const [optimisticBoard, setOptimisticBoard] = createSignal<BoardColumn[] | null>(null);
  const [pendingVirtual, setPendingVirtual] = createSignal<Partial<Record<SpaceVirtualColumnKind, boolean>>>({});
  // Statuses and enabled automatic columns share one board order. A switch shows its column change at
  // once, where the server puts it, so the list never offers to move a column that is already gone.
  const board = () => {
    const optimistic = optimisticBoard();
    if (optimistic) return optimistic;
    const pending = pendingVirtual();
    const stored = orderBoardColumns(props.columns, props.virtualColumns).filter(
      (entry) => entry.kind === "column" || pending[entry.kind] !== false,
    );
    for (const kind of ["blocked", "overdue"] as const) {
      if (!pending[kind] || stored.some((entry) => entry.kind === kind)) continue;
      const firstDone = stored.findIndex((entry) => entry.kind === "column" && entry.column.isDone);
      stored.splice(firstDone < 0 ? stored.length : firstDone, 0, { kind, rank: "0" });
    }
    return stored;
  };
  const columns = () => board().flatMap((entry) => (entry.kind === "column" ? [entry.column] : []));
  const virtualLabel = (kind: SpaceVirtualColumnKind) => (kind === "blocked" ? m.blockedColumn : m.overdueColumn);
  const entryLabel = (entry: BoardColumn) => (entry.kind === "column" ? entry.column.name : virtualLabel(entry.kind));
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
        setOptimisticBoard(null);
        return;
      }
      void refresh.catch((error) => prompts.error(error.message)).finally(() => setOptimisticBoard(null));
    },
    onError: (err) => {
      setOptimisticBoard(null);
      prompts.error(err.message);
    },
    onAbort: () => setOptimisticBoard(null),
  });

  const virtualEnabled = (kind: SpaceVirtualColumnKind) =>
    pendingVirtual()[kind] ?? props.virtualColumns.some((virtual) => virtual.kind === kind);
  const toggleVirtualMut = mutations.create({
    onBefore: ({ kind, enabled }: { kind: SpaceVirtualColumnKind; enabled: boolean }) =>
      setPendingVirtual({ ...pendingVirtual(), [kind]: enabled }),
    mutation: async ({ kind, enabled }: { kind: SpaceVirtualColumnKind; enabled: boolean }) => {
      const route = apiClient[":id"]["virtual-columns"][":kind"];
      const res = enabled
        ? await route.$put({ param: { id: props.spaceId, kind } })
        : await route.$delete({ param: { id: props.spaceId, kind } });
      if (!res.ok) throw new Error(await readErrorMessage(res, m.virtualColumnChangeFailed));
    },
    onSuccess: () => {
      props.onWorkspaceChange?.();
      const refresh = props.onSettingsChange?.() ?? Promise.resolve();
      void refresh.catch((error) => prompts.error(error.message)).finally(() => setPendingVirtual({}));
    },
    onError: (err) => {
      setPendingVirtual({});
      prompts.error(err.message);
    },
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
    if (reorderSubmitting || reorderMut.loading() || toggleVirtualMut.loading()) return;
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= board().length) return;

    const next = [...board()];
    const [moved] = next.splice(index, 1);
    next.splice(newIndex, 0, moved!);
    setOptimisticBoard(next);

    reorderSubmitting = true;
    void reorderMut.mutate({ columnIds: next.map(boardColumnOrderId) }).finally(() => (reorderSubmitting = false));
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

      {/* Above the list: the rows a switch adds or removes then never move the switch itself. */}
      <SettingsGroup title={m.automaticColumns} description={m.automaticColumnsDescription}>
        <For each={["blocked", "overdue"] as const}>
          {(kind) => (
            <Switch
              label={virtualLabel(kind)}
              description={kind === "blocked" ? m.blockedColumnDescription : m.overdueColumnDescription}
              value={virtualEnabled(kind)}
              disabled={toggleVirtualMut.loading() || reorderMut.loading()}
              onValueChange={(enabled) => void toggleVirtualMut.mutate({ kind, enabled })}
            />
          )}
        </For>
      </SettingsGroup>

      <SettingsCollection title={m.workflowStatuses} description={m.workflowStatusesDescription} empty={m.noStatuses}>
        <SettingsCollection.Action>
          <Button type="button" size="sm" disabled={editingId() !== null} onClick={() => setEditingId("new")}>
            <i class="ti ti-plus" aria-hidden="true" />
            {m.newStatus}
          </Button>
        </SettingsCollection.Action>
        <For each={board()}>
          {(entry, index) => {
            const position = () => m.positionOf({ position: index() + 1, count: board().length });
            const reorder = () => (
              <SettingsCollection.Item.Reorder
                label={entryLabel(entry)}
                index={index()}
                count={board().length}
                disabled={reorderMut.loading() || toggleVirtualMut.loading()}
                onMove={(direction) => moveColumn(index(), direction)}
              />
            );
            if (entry.kind !== "column") {
              return (
                <SettingsCollection.Item
                  title={virtualLabel(entry.kind)}
                  description={`${m.automaticColumn} · ${position()}`}
                  icon={<i class={`ti ${entry.kind === "blocked" ? "ti-lock" : "ti-alert-triangle"} text-dimmed`} aria-hidden="true" />}
                >
                  <SettingsCollection.Item.Actions>{reorder()}</SettingsCollection.Item.Actions>
                </SettingsCollection.Item>
              );
            }
            const column = entry.column;
            return (
              <SettingsCollection.Item
                title={column.name}
                description={position()}
                icon={<span class="h-3 w-3 rounded-full" style={`background-color:${column.color || "#6b7280"}`} />}
              >
                <SettingsCollection.Item.Actions>
                  {reorder()}
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
            );
          }}
        </For>
      </SettingsCollection>
    </>
  );
}
