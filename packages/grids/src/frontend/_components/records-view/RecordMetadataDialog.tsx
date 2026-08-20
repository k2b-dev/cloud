import { Avatar, Button, Combobox, type ComboboxOption, dialogCore, PanelDialog, panelDialogOptions, prompts, Select, Tag } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { RecordActor, RecordFinalizationState, RecordMetaQuery, RecordMetaUserKey } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";

type UserKeyConfig = {
  key: RecordMetaUserKey;
  label: string;
};

const USER_KEYS: UserKeyConfig[] = [
  {
    key: "createdBy",
    label: "Created by",
  },
  {
    key: "updatedBy",
    label: "Modified by",
  },
  {
    key: "deletedBy",
    label: "Deleted by",
  },
];

const cleanIds = (ids: string[] | undefined): string[] => [...new Set((ids ?? []).filter(Boolean))];

export const cleanRecordMetaQuery = (meta: RecordMetaQuery | null | undefined): RecordMetaQuery | undefined => {
  if (!meta) return undefined;
  const finalizationStates = [...new Set(meta.finalizationStates ?? [])];
  const createdBy = cleanIds(meta.users?.createdBy);
  const updatedBy = cleanIds(meta.users?.updatedBy);
  const deletedBy = cleanIds(meta.users?.deletedBy);
  const users =
    createdBy.length || updatedBy.length || deletedBy.length
      ? {
          ...(createdBy.length ? { createdBy } : {}),
          ...(updatedBy.length ? { updatedBy } : {}),
          ...(deletedBy.length ? { deletedBy } : {}),
        }
      : undefined;
  return finalizationStates.length || users
    ? { ...(finalizationStates.length ? { finalizationStates } : {}), ...(users ? { users } : {}) }
    : undefined;
};

export const recordMetaActiveCount = (meta: RecordMetaQuery | null | undefined): number => {
  const cleaned = cleanRecordMetaQuery(meta);
  if (!cleaned) return 0;
  return USER_KEYS.reduce((count, cfg) => count + (cleaned.users?.[cfg.key]?.length ? 1 : 0), cleaned.finalizationStates?.length ? 1 : 0);
};

const actorToOption = (actor: RecordActor): ComboboxOption => ({
  id: actor.id,
  label: actor.label,
  description: actor.subtitle ?? undefined,
  icon: "ti ti-user",
});

const fetchActors = async (tableId: string, kind: RecordMetaUserKey | "any", query: string, ids: string[] = []): Promise<RecordActor[]> => {
  const res = await apiClient.tables[":tableId"]["record-actors"].$get({
    param: { tableId },
    query: {
      kind,
      q: query,
      ids: ids.join(","),
      limit: String(ids.length > 0 ? Math.max(ids.length, 12) : 12),
    },
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Failed to load users"));
  return (await res.json()).items;
};

const ActorPicker = (props: {
  tableId: string;
  config: UserKeyConfig;
  selectedIds: () => string[];
  labels: () => Record<string, RecordActor>;
  setLabels: (next: Record<string, RecordActor>) => void;
  onChange: (next: string[]) => void;
}) => {
  const selectedActors = () => props.selectedIds().map((id) => props.labels()[id] ?? { id, label: id, subtitle: null, avatarHash: null });

  createEffect(() => {
    const missing = props.selectedIds().filter((id) => !props.labels()[id]);
    if (missing.length === 0) return;
    void fetchActors(props.tableId, "any", "", missing)
      .then((actors) => {
        const next = { ...props.labels() };
        for (const actor of actors) next[actor.id] = actor;
        props.setLabels(next);
      })
      .catch((error) => prompts.error(error instanceof Error ? error.message : "Failed to load users"));
  });

  const remove = (id: string) => props.onChange(props.selectedIds().filter((selected) => selected !== id));
  const add = (option: ComboboxOption) => {
    if (props.selectedIds().includes(option.id)) return;
    props.setLabels({
      ...props.labels(),
      [option.id]: props.labels()[option.id] ?? {
        id: option.id,
        label: option.label,
        subtitle: option.description ?? null,
        avatarHash: null,
      },
    });
    props.onChange([...props.selectedIds(), option.id]);
  };

  return (
    <div class="grid gap-2 py-1 md:grid-cols-[10rem_1fr] md:items-start">
      <div class="min-w-0 pt-1">
        <div class="text-sm font-medium leading-tight">{props.config.label}</div>
      </div>
      <div class="min-w-0">
        <Show when={selectedActors().length > 0}>
          <div class="mb-2 flex flex-wrap gap-1.5">
            <For each={selectedActors()}>
              {(actor) => (
                <Tag size="sm" class="max-w-full" onRemove={() => remove(actor.id)} removeLabel={`Remove ${actor.label}`}>
                  <Avatar
                    name={actor.label}
                    src={
                      actor.avatarHash
                        ? `/api/accounts/users/${encodeURIComponent(actor.id)}/avatar?rev=${encodeURIComponent(actor.avatarHash)}`
                        : null
                    }
                    size="xs"
                    class="h-4! w-4! text-[8px]!"
                  />
                  <span class="truncate">{actor.label}</span>
                  <i class="ti ti-x text-xs opacity-60" />
                </Tag>
              )}
            </For>
          </div>
        </Show>
        <Combobox
          aria-label="Search users"
          placeholder="Search users..."
          fetchData={async (query) => {
            const actors = await fetchActors(props.tableId, props.config.key, query);
            const next = { ...props.labels() };
            for (const actor of actors) next[actor.id] = actor;
            props.setLabels(next);
            return actors.map(actorToOption);
          }}
          onSelect={add}
        />
      </div>
    </div>
  );
};

export const openRecordMetadataDialog = (args: {
  tableId: string;
  initial?: RecordMetaQuery | null;
}): Promise<RecordMetaQuery | undefined | null> =>
  dialogCore.open<RecordMetaQuery | undefined | null>((close) => {
    const initial = cleanRecordMetaQuery(args.initial);
    const [createdBy, setCreatedBy] = createSignal<string[]>(cleanIds(initial?.users?.createdBy));
    const [updatedBy, setUpdatedBy] = createSignal<string[]>(cleanIds(initial?.users?.updatedBy));
    const [deletedBy, setDeletedBy] = createSignal<string[]>(cleanIds(initial?.users?.deletedBy));
    const [finalizationState, setFinalizationState] = createSignal<RecordFinalizationState | null>(
      initial?.finalizationStates?.[0] ?? null,
    );
    const [labels, setLabels] = createSignal<Record<string, RecordActor>>({});

    const build = (): RecordMetaQuery | undefined =>
      cleanRecordMetaQuery({
        finalizationStates: finalizationState() ? [finalizationState()!] : [],
        users: {
          createdBy: createdBy(),
          updatedBy: updatedBy(),
          deletedBy: deletedBy(),
        },
      });

    const apply = () => close(build());

    return (
      <PanelDialog>
        <PanelDialog.Header
          title="Record metadata"
          subtitle="Filter by Finalization state or by who changed records."
          icon="ti ti-user-search"
          close={() => close(null)}
        />
        <PanelDialog.Body>
          <div class="flex flex-col gap-3">
            <Select
              label="Finalization state"
              value={finalizationState}
              onValueChange={(value) =>
                setFinalizationState(value === "draft" || value === "awaitingReview" || value === "finalized" ? value : null)
              }
              placeholder="Any state"
              clearable
              options={[
                { id: "draft", label: "Draft", description: "Finalization is active, with no current review request.", icon: "ti ti-edit" },
                {
                  id: "awaitingReview",
                  label: "Awaiting review",
                  description: "A current Four-eyes request is waiting for another person.",
                  icon: "ti ti-users",
                },
                { id: "finalized", label: "Finalized", description: "The Record is locked as a final version.", icon: "ti ti-lock" },
              ]}
            />
            <For each={USER_KEYS}>
              {(config) => (
                <ActorPicker
                  tableId={args.tableId}
                  config={config}
                  selectedIds={() => (config.key === "createdBy" ? createdBy() : config.key === "updatedBy" ? updatedBy() : deletedBy())}
                  labels={labels}
                  setLabels={setLabels}
                  onChange={(next) => {
                    if (config.key === "createdBy") setCreatedBy(next);
                    else if (config.key === "updatedBy") setUpdatedBy(next);
                    else setDeletedBy(next);
                  }}
                />
              )}
            </For>
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button variant="ghost" size="sm" type="button" onClick={() => close(undefined)}>
            Clear
          </Button>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={apply}>
              Apply
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
