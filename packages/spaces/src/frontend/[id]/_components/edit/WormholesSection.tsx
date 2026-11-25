import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Button, confirm, Dialog, Empty, Failed, Field, Menu, Notice, Row, Section, Select, useToast } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceWormhole, SpaceWormholeDestination } from "@/contracts";
import { spaceColorOptions } from "../../../_components/space-colors";
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
  const locale = useLocale();
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

  const submit = () => {
    const columnId = selectedColumnId();
    if (!columnId) return;
    props.onSave({ targetColumnId: columnId, color: color() });
  };

  return (
    <Dialog
      title={props.initial ? m.editWormhole : m.newWormhole}
      open
      onOpenChange={(open) => !open && props.onCancel()}
      foot={
        <>
          <Button onClick={props.onCancel} disabled={props.loading}>
            {m.cancel}
          </Button>
          <Button variant="primary" busy={props.loading} disabled={!selectedColumnId()} onClick={submit}>
            {props.initial ? m.save : m.createWormhole}
          </Button>
        </>
      }
    >
      <Field label={m.destinationSpace} name="wormhole-space" hint={m.destinationSpaceDescription} required>
        <Select
          value={targetSpaceId()}
          options={props.destinations.map((destination) => ({ value: destination.spaceId, label: destination.spaceName }))}
          onChange={changeTargetSpace}
        />
      </Field>
      <Field label={m.destinationStatus} name="wormhole-status" hint={m.destinationStatusDescription} required>
        <Select
          value={selectedColumnId()}
          options={columns().map((column) => ({ value: column.id, label: column.name }))}
          onChange={setTargetColumnId}
        />
      </Field>
      <Field label={m.color} name="wormhole-color" hint={m.wormholeColorDescription}>
        {/* k2b-ui gap: v2 has no colour input; the named palette, with the current colour as its own entry. */}
        <Select value={color()} options={spaceColorOptions(locale(), color())} onChange={setColor} />
      </Field>
    </Dialog>
  );
}

export function WormholesSection(props: { spaceId: string; initialWormholes: SpaceWormhole[]; onDirtyChange: (dirty: boolean) => void }) {
  const m = useSpaceMessages();
  const toast = useToast();
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
  const refreshWormholes = () =>
    void wormholesQuery.invalidate({ cursor: null }).catch(() => toast(m.refreshWormholesFailed, { status: "bad" }));

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
      refreshWormholes();
    },
    onError: (error) => toast(error.message, { status: "bad" }),
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
      refreshWormholes();
    },
    onError: (error) => toast(error.message, { status: "bad" }),
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
      refreshWormholes();
    },
    onError: (error) => toast(error.message, { status: "bad" }),
  });
  let deletePromptPending = false;
  const deleteWormhole = async (wormhole: SpaceWormhole) => {
    if (deletePromptPending || deleteMutation.loading()) return;
    deletePromptPending = true;
    try {
      const label = wormhole.target ? `${wormhole.target.spaceName} / ${wormhole.target.columnName}` : m.unavailableDestinationArticle;
      const confirmed = await confirm({
        title: m.deleteWormhole,
        description: m.deleteWormholeConfirm({ destination: label }),
        confirm: m.delete,
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
        .catch(() => toast(m.refreshWormholeOrderFailed, { status: "bad" }))
        .finally(() => setOptimisticOrder(null));
    },
    onError: (error) => {
      setOptimisticOrder(null);
      toast(error.message, { status: "bad" });
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

  const label = (wormhole: SpaceWormhole) =>
    wormhole.target ? `${wormhole.target.spaceName} / ${wormhole.target.columnName}` : m.unavailableDestination;
  const editable = () => editingId() === null && !destinationsQuery.loading() && destinations().length > 0;
  return (
    <Section
      icon="arrow-bounce"
      title={m.destinations}
      summary={m.destinationsDescription}
      count={wormholes().length}
      actions={[{ label: m.newWormholeAction, icon: "plus", disabled: !editable(), onClick: () => setEditingId("new") }]}
    >
      <Show when={wormholesQuery.error()}>
        {(error) => <Failed text={`${m.wormholesUnavailable}: ${error().message}`} onRetry={() => void wormholesQuery.refresh()} />}
      </Show>
      <Show when={destinationsQuery.error()}>
        <Failed
          text={`${m.destinationsUnavailable}. ${m.destinationsUnavailableDescription}`}
          onRetry={() => void destinationsQuery.refresh()}
        />
      </Show>
      <Show when={!destinationsQuery.loading() && !destinationsQuery.error() && destinations().length === 0}>
        <Notice tone="note">{m.noWormholeDestination}</Notice>
      </Show>
      <Show when={wormholes().length > 0} fallback={<Empty icon="arrow-bounce" text={m.noWormholes} />}>
        <For each={wormholes()}>
          {(wormhole, index) => (
            <Row
              icon="arrow-bounce"
              color={wormhole.color}
              lines={[
                label(wormhole),
                wormhole.target
                  ? m.wormholePositionDescription({ position: index() + 1, count: wormholes().length })
                  : m.restoreDestinationAccess,
              ]}
              end={
                <Menu
                  label={m.moreActionsFor({ label: label(wormhole) })}
                  items={[
                    {
                      label: m.moveUp,
                      icon: "arrow-up",
                      disabled: reorderMutation.loading() || index() === 0,
                      onClick: () => move(index(), -1),
                    },
                    {
                      label: m.moveDown,
                      icon: "arrow-down",
                      disabled: reorderMutation.loading() || index() === wormholes().length - 1,
                      onClick: () => move(index(), 1),
                    },
                    ...(wormhole.target
                      ? [{ label: m.editWormhole, icon: "pencil", disabled: !editable(), onClick: () => setEditingId(wormhole.id) }]
                      : []),
                    {
                      label: m.deleteWormhole,
                      icon: "trash",
                      danger: true,
                      disabled: deleteMutation.loading(),
                      onClick: () => void deleteWormhole(wormhole),
                    },
                  ]}
                />
              }
            />
          )}
        </For>
      </Show>
      <Show when={editingId()}>
        {(id) => (
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
        )}
      </Show>
    </Section>
  );
}
