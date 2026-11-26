import { mutation as mutations } from "@k2b/stdlib/solid";
import { Check, confirm, Empty, Menu, type MenuEntry, Row, Section, useToast } from "@k2b/ui/v2";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type BoardColumn, boardColumnOrderId, orderBoardColumns } from "@/board-columns";
import type { SpaceColumn, SpaceVirtualColumn, SpaceVirtualColumnKind } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { statusColor } from "../list/ItemRow";
import { NameColorDialog } from "./NameColorForm";
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
  const toast = useToast();
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
  const [editingId, setEditingId] = createSignal<string | "new" | null>(null);
  const reconcile = () => void props.onSettingsChange?.().catch((error) => toast(error.message, { status: "bad" }));

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
    onError: (err) => toast(err.message, { status: "bad" }),
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
    onError: (err) => toast(err.message, { status: "bad" }),
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
    onError: (err) => toast(err.message, { status: "bad" }),
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
      void refresh.catch((error) => toast(error.message, { status: "bad" })).finally(() => setOptimisticBoard(null));
    },
    onError: (err) => {
      setOptimisticBoard(null);
      toast(err.message, { status: "bad" });
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
      void refresh.catch((error) => toast(error.message, { status: "bad" })).finally(() => setPendingVirtual({}));
    },
    onError: (err) => {
      setPendingVirtual({});
      toast(err.message, { status: "bad" });
    },
  });
  let reorderSubmitting = false;
  let deletePromptPending = false;
  const deleteColumn = async (column: SpaceColumn) => {
    if (deletePromptPending || deleteMut.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await confirm({
        title: m.deleteStatus,
        description: m.deleteStatusConfirm({ name: column.name }),
        confirm: m.delete,
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

  const editingColumn = () => columns().find((item) => item.id === editingId());
  return (
    <>
      {/* Above the list: the rows a switch adds or removes never move the switch itself. */}
      <Section icon="robot" title={m.automaticColumns} summary={m.automaticColumnsDescription}>
        <For each={["blocked", "overdue"] as const}>
          {(kind) => (
            <Row
              icon={kind === "blocked" ? "lock" : "alert-triangle"}
              lines={[virtualLabel(kind), kind === "blocked" ? m.blockedColumnDescription : m.overdueColumnDescription]}
              end={
                <Check
                  switch
                  label={virtualLabel(kind)}
                  checked={virtualEnabled(kind)}
                  disabled={toggleVirtualMut.loading() || reorderMut.loading()}
                  onChange={(enabled) => void toggleVirtualMut.mutate({ kind, enabled })}
                />
              }
            />
          )}
        </For>
      </Section>
      <Section
        icon="columns-3"
        title={m.workflowStatuses}
        summary={m.workflowStatusesDescription}
        count={columns().length}
        actions={[{ label: m.newStatus, icon: "plus", disabled: editingId() !== null, onClick: () => setEditingId("new") }]}
      >
        <Show when={board().length > 0} fallback={<Empty icon="columns-3" text={m.noStatuses} />}>
          <For each={board()}>
            {(entry, index) => {
              const position = () => m.positionOf({ position: index() + 1, count: board().length });
              const moving = () => reorderMut.loading() || toggleVirtualMut.loading();
              // k2b-ui gap: no drag handle for a list in v2 yet; a status moves one place up or down from its menu.
              const moves = (): MenuEntry[] => [
                { label: m.moveUp, icon: "arrow-up", disabled: moving() || index() === 0, onClick: () => moveColumn(index(), -1) },
                {
                  label: m.moveDown,
                  icon: "arrow-down",
                  disabled: moving() || index() === board().length - 1,
                  onClick: () => moveColumn(index(), 1),
                },
              ];
              return entry.kind !== "column" ? (
                <Row
                  icon={entry.kind === "blocked" ? "lock" : "alert-triangle"}
                  lines={[virtualLabel(entry.kind), `${m.automaticColumn} · ${position()}`]}
                  end={<Menu label={m.moreActionsFor({ label: virtualLabel(entry.kind) })} items={moves()} />}
                />
              ) : (
                <Row
                  mark={{ icon: entry.column.isDone ? "circle-check" : "circle-dot", color: statusColor(entry.column) }}
                  lines={[entry.column.name, position()]}
                  end={
                    <Menu
                      label={m.moreActionsFor({ label: entry.column.name })}
                      items={[
                        ...moves(),
                        { label: m.editGenericStatus, icon: "pencil", onClick: () => setEditingId(entry.column.id) },
                        { label: m.deleteStatus, icon: "trash", danger: true, onClick: () => void deleteColumn(entry.column) },
                      ]}
                    />
                  }
                />
              );
            }}
          </For>
        </Show>
      </Section>
      <Show when={editingId()}>
        {(id) => (
          <NameColorDialog
            title={id() === "new" ? m.newStatus : editingColumn() ? m.editStatus({ name: editingColumn()!.name }) : m.editGenericStatus}
            initialName={editingColumn()?.name}
            initialColor={editingColumn()?.color}
            namePlaceholder={m.statusNamePlaceholder}
            confirmLabel={id() === "new" ? m.createStatus : m.save}
            busy={createMut.loading() || updateMut.loading()}
            onSave={(data) => {
              const current = editingColumn();
              setEditingId(null);
              if (id() === "new") void createMut.mutate(data);
              else if (current) void updateMut.mutate({ id: current.id, name: data.name, color: data.color });
            }}
            onClose={() => setEditingId(null)}
          />
        )}
      </Show>
    </>
  );
}
