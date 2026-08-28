import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, ColorInput, IconButton, prompts, Select, SettingsCollection, SettingsGroup, toast } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceWormhole, SpaceWormholeDestination } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { subscribeToSpacesDataInvalidation } from "../workspace/workspace-events";
import { readErrorMessage } from "./utils";

type FormValue = { targetColumnId: string; color: string };

function WormholeForm(props: {
  destinations: SpaceWormholeDestination[];
  initial?: SpaceWormhole;
  loading: boolean;
  onCancel: () => void;
  onSave: (value: FormValue) => void;
}) {
  const m = useSpaceMessages();
  const initialTarget = props.initial?.target;
  const [targetSpaceId, setTargetSpaceId] = createSignal(initialTarget?.spaceId ?? props.destinations[0]?.spaceId ?? "");
  const [targetColumnId, setTargetColumnId] = createSignal(initialTarget?.columnId ?? "");
  const [color, setColor] = createSignal(props.initial?.color ?? "#6366f1");
  const selectedDestination = createMemo(() => props.destinations.find((destination) => destination.spaceId === targetSpaceId()));
  const columns = createMemo(() => selectedDestination()?.columns ?? []);
  const selectedColumnId = () => targetColumnId() || columns()[0]?.id || "";

  const changeTargetSpace = (spaceId: string) => {
    setTargetSpaceId(spaceId);
    const destination = props.destinations.find((item) => item.spaceId === spaceId);
    setTargetColumnId(destination?.columns[0]?.id ?? "");
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const columnId = selectedColumnId();
    if (!columnId) return;
    props.onSave({ targetColumnId: columnId, color: color() });
  };

  return (
    <form onSubmit={submit} class="flex flex-col gap-3 py-2">
      <Select
        label={m.destinationSpace}
        description={m.destinationSpaceDescription}
        value={targetSpaceId}
        onValueChange={(value) => value && changeTargetSpace(value)}
        options={props.destinations.map((destination) => ({
          value: destination.spaceId,
          label: destination.spaceName,
          icon: "ti ti-layout-kanban",
        }))}
        required
      />
      <Select
        label={m.destinationStatus}
        description={m.destinationStatusDescription}
        value={selectedColumnId}
        onValueChange={(value) => value && setTargetColumnId(value)}
        options={columns().map((column) => ({ value: column.id, label: column.name, icon: "ti ti-columns-3" }))}
        disabled={columns().length === 0}
        required
      />
      <ColorInput label={m.color} description={m.wormholeColorDescription} value={color} onValueChange={setColor} />
      <div class="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={props.loading || !selectedColumnId()}>
          <i class={`ti ${props.loading ? "ti-loader-2 animate-spin" : "ti-check"}`} />
          {props.initial ? m.save : m.createWormhole}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={props.onCancel} disabled={props.loading}>
          {m.cancel}
        </Button>
      </div>
    </form>
  );
}

export function WormholesSection(props: { spaceId: string; initialWormholes: SpaceWormhole[]; onDirtyChange: (dirty: boolean) => void }) {
  const m = useSpaceMessages();
  const [optimisticOrder, setOptimisticOrder] = createSignal<SpaceWormhole[] | null>(null);
  const [editingId, setEditingId] = createSignal<string | "new" | null>(null);

  createEffect(() => props.onDirtyChange(editingId() !== null));
  onCleanup(() => props.onDirtyChange(false));

  const wormholesQuery = query.create<string, SpaceWormhole[], { cursor: string | null }>({
    source: () => props.spaceId,
    initial: { source: props.spaceId, data: props.initialWormholes },
    load: async (spaceId, ctx) => {
      const response = await apiClient[":id"].wormholes.configured.$get({ param: { id: spaceId } }, { init: { signal: ctx.abortSignal } });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.loadWormholesFailed));
      return response.json();
    },
    subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["wormholes"], invalidate),
  });
  const wormholes = () => optimisticOrder() ?? wormholesQuery.data() ?? props.initialWormholes;
  const refreshWormholes = () => void wormholesQuery.invalidate({ cursor: null }).catch(() => prompts.error(m.refreshWormholesFailed));

  const destinationsQuery = query.create<string, SpaceWormholeDestination[], { cursor: string | null }>({
    source: () => props.spaceId,
    load: async (spaceId, ctx) => {
      const response = await apiClient[":id"]["wormhole-destinations"].$get(
        { param: { id: spaceId } },
        { init: { signal: ctx.abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, m.loadDestinationsFailed));
      return response.json();
    },
    subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["wormholes"], invalidate),
  });

  const createMutation = mutations.create<SpaceWormhole, FormValue>({
    mutation: async (value) => {
      const response = await apiClient[":id"].wormholes.$post({ param: { id: props.spaceId }, json: value });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.createWormholeFailed));
      return response.json();
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success(m.wormholeCreated);
      refreshWormholes();
    },
    onError: (error) => prompts.error(error.message),
  });

  const updateMutation = mutations.create<SpaceWormhole, FormValue & { id: string }>({
    mutation: async ({ id, ...value }) => {
      const response = await apiClient[":id"].wormholes[":wormholeId"].$patch({
        param: { id: props.spaceId, wormholeId: id },
        json: value,
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.updateWormholeFailed));
      return response.json();
    },
    onSuccess: () => {
      setEditingId(null);
      toast.success(m.wormholeUpdated);
      refreshWormholes();
    },
    onError: (error) => prompts.error(error.message),
  });

  const deleteMutation = mutations.create<string, SpaceWormhole>({
    mutation: async (wormhole) => {
      const response = await apiClient[":id"].wormholes[":wormholeId"].$delete({
        param: { id: props.spaceId, wormholeId: wormhole.id },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.deleteWormholeFailed));
      return wormhole.id;
    },
    onSuccess: (id) => {
      if (editingId() === id) setEditingId(null);
      toast.success(m.wormholeDeleted);
      refreshWormholes();
    },
    onError: (error) => prompts.error(error.message),
  });
  let deletePromptPending = false;
  const deleteWormhole = async (wormhole: SpaceWormhole) => {
    if (deletePromptPending || deleteMutation.loading()) return;
    deletePromptPending = true;
    try {
      const label = wormhole.target ? `${wormhole.target.spaceName} / ${wormhole.target.columnName}` : m.unavailableDestinationArticle;
      const confirmed = await prompts.confirm(m.deleteWormholeConfirm({ destination: label }), {
        title: m.deleteWormhole,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: m.delete,
      });
      if (confirmed) void deleteMutation.mutate(wormhole);
    } finally {
      deletePromptPending = false;
    }
  };

  const reorderMutation = mutations.create<void, { ids: string[] }>({
    mutation: async ({ ids }) => {
      const response = await apiClient[":id"].wormholes.order.$put({
        param: { id: props.spaceId },
        json: { wormholeIds: ids },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, m.reorderWormholesFailed));
    },
    onSuccess: () => {
      void wormholesQuery
        .invalidate({ cursor: null })
        .catch(() => prompts.error(m.refreshWormholeOrderFailed))
        .finally(() => setOptimisticOrder(null));
    },
    onError: (error) => {
      setOptimisticOrder(null);
      prompts.error(error.message);
    },
    onAbort: () => setOptimisticOrder(null),
  });
  let reorderSubmitting = false;

  const move = (index: number, direction: -1 | 1) => {
    if (reorderSubmitting || reorderMutation.loading()) return;
    const nextIndex = index + direction;
    const previous = wormholes();
    if (nextIndex < 0 || nextIndex >= previous.length) return;
    const next = [...previous];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(nextIndex, 0, moved);
    setOptimisticOrder(next);
    reorderSubmitting = true;
    void reorderMutation.mutate({ ids: next.map((wormhole) => wormhole.id) }).finally(() => (reorderSubmitting = false));
  };

  const destinations = () => destinationsQuery.data() ?? [];
  const formLoading = () => createMutation.loading() || updateMutation.loading();

  const editingWormhole = () => {
    const id = editingId();
    return id && id !== "new" ? wormholes().find((wormhole) => wormhole.id === id) : undefined;
  };

  return (
    <>
      <Show when={editingId()}>
        {(id) => (
          <SettingsGroup title={id() === "new" ? m.newWormhole : m.editWormhole} description={m.wormholeFormDescription}>
            <WormholeForm
              destinations={destinations()}
              initial={editingWormhole()}
              loading={formLoading()}
              onCancel={() => setEditingId(null)}
              onSave={(value) => {
                const wormhole = editingWormhole();
                if (id() === "new") createMutation.mutate(value);
                else if (wormhole) updateMutation.mutate({ id: wormhole.id, ...value });
              }}
            />
          </SettingsGroup>
        )}
      </Show>

      <SettingsCollection title={m.destinations} description={m.destinationsDescription} empty={m.noWormholes}>
        <SettingsCollection.Action>
          <Button
            type="button"
            size="sm"
            disabled={editingId() !== null || destinationsQuery.loading() || destinations().length === 0}
            onClick={() => setEditingId("new")}
          >
            <i class={`ti ${destinationsQuery.loading() ? "ti-loader-2 animate-spin" : "ti-plus"}`} aria-hidden="true" />
            {m.newWormholeAction}
          </Button>
        </SettingsCollection.Action>
        <For each={wormholes()}>
          {(wormhole, index) => (
            <SettingsCollection.Item
              title={wormhole.target ? `${wormhole.target.spaceName} / ${wormhole.target.columnName}` : m.unavailableDestination}
              description={
                wormhole.target
                  ? m.wormholePositionDescription({ position: index() + 1, count: wormholes().length })
                  : m.restoreDestinationAccess
              }
              icon={<span class="h-3 w-3 rounded-full" style={`background-color:${wormhole.color}`} />}
            >
              <SettingsCollection.Item.Actions>
                <SettingsCollection.Item.Reorder
                  label={wormhole.target ? `${wormhole.target.spaceName} / ${wormhole.target.columnName}` : m.wormholeLabel}
                  index={index()}
                  count={wormholes().length}
                  disabled={reorderMutation.loading()}
                  onMove={(direction) => move(index(), direction)}
                />
                <Show when={wormhole.target}>
                  <IconButton
                    label={m.editWormhole}
                    size="sm"
                    title={m.edit}
                    disabled={editingId() !== null || destinationsQuery.loading() || destinations().length === 0}
                    onClick={() => setEditingId(wormhole.id)}
                  >
                    <i class="ti ti-pencil" aria-hidden="true" />
                  </IconButton>
                </Show>
                <IconButton
                  label={m.deleteWormhole}
                  size="sm"
                  title={m.delete}
                  disabled={deleteMutation.loading()}
                  onClick={() => void deleteWormhole(wormhole)}
                >
                  <i class="ti ti-trash" aria-hidden="true" />
                </IconButton>
              </SettingsCollection.Item.Actions>
            </SettingsCollection.Item>
          )}
        </For>
      </SettingsCollection>

      <Show when={wormholesQuery.error()}>
        <SettingsGroup title={m.wormholesUnavailable} description={wormholesQuery.error()!.message}>
          <SettingsGroup.Action>
            <Button type="button" variant="secondary" size="sm" onClick={() => void wormholesQuery.refresh()}>
              <i class="ti ti-refresh" aria-hidden="true" /> {m.retry}
            </Button>
          </SettingsGroup.Action>
        </SettingsGroup>
      </Show>

      <Show when={destinationsQuery.error()}>
        <SettingsGroup title={m.destinationsUnavailable} description={m.destinationsUnavailableDescription}>
          <SettingsGroup.Action>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void destinationsQuery.refresh();
              }}
            >
              <i class="ti ti-refresh" aria-hidden="true" /> {m.retry}
            </Button>
          </SettingsGroup.Action>
        </SettingsGroup>
      </Show>

      <Show when={!destinationsQuery.loading() && !destinationsQuery.error() && destinations().length === 0}>
        <p class="text-sm text-dimmed">{m.noWormholeDestination}</p>
      </Show>
    </>
  );
}
