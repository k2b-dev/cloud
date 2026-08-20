import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, Placeholder, prompts, Select, SettingsCollection, StatusBadge, TextInput, toast } from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicTable } from "../../../api/public-dto";
import {
  type CreatePreservationHoldInput,
  PRESERVATION_HOLD_REASON_MAX_LENGTH,
  type PreservationHold,
  type PreservationHoldsResponse,
} from "../../../preservation-hold-contracts";
import { errorMessage } from "../utils/api-helpers";

const askReleaseReason = () =>
  prompts.form({
    title: "Release preservation hold",
    icon: "ti ti-lock-open",
    fields: {
      explanation: {
        type: "info" as const,
        content: "This releases only the selected hold. Other active holds continue to block controlled destruction.",
      },
      reason: {
        type: "text" as const,
        label: "Reason",
        description: "Why can this hold be released?",
        required: true,
        multiline: true,
        lines: 3,
        maxLength: PRESERVATION_HOLD_REASON_MAX_LENGTH,
      },
    },
    confirmText: "Release hold",
    variant: "danger",
  });

export const buildPreservationHoldInput = (
  scope: "base" | "table",
  tableId: string | null,
  reason: string,
): CreatePreservationHoldInput | null => {
  const trimmedReason = reason.trim();
  if (!trimmedReason || trimmedReason.length > PRESERVATION_HOLD_REASON_MAX_LENGTH) return null;
  if (scope === "table") return tableId ? { reason: trimmedReason, scope: { type: "table", tableId } } : null;
  return { reason: trimmedReason, scope: { type: "base" } };
};

export const CreatePreservationHoldDialog = (props: { baseId: string; close: (input?: CreatePreservationHoldInput) => void }) => {
  const [scope, setScope] = createSignal<"base" | "table">("base");
  const [tableId, setTableId] = createSignal<string | null>(null);
  const [reason, setReason] = createSignal("");
  const input = () => buildPreservationHoldInput(scope(), tableId(), reason());

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = input();
        if (value) props.close(value);
      }}
    >
      <div class="k2b-dialog__body">
        <p>This blocks future controlled destruction in the selected scope. Records remain editable and access does not change.</p>
        <Select
          label="Scope"
          description="Choose the complete Base or one active Table."
          required
          value={scope}
          onValueChange={(value) => {
            setScope(value === "table" ? "table" : "base");
            if (value !== "table") setTableId(null);
          }}
          options={[
            { id: "base", label: "Entire Base", description: "Blocks controlled destruction across every Table." },
            {
              id: "table",
              label: "One Table",
              description: "Preserves only this Table's contents. The parent Base cannot be destroyed while the hold is active.",
            },
          ]}
        />
        <Show when={scope() === "table"}>
          <Select
            label="Table"
            description="Search active Tables in this Base."
            placeholder="Search Tables..."
            required
            value={tableId}
            onValueChange={setTableId}
            fetchData={async (search, signal) => {
              const response = await apiClient.tables["by-base"][":baseId"].$get(
                { param: { baseId: props.baseId }, query: { q: search, limit: "25" } },
                { init: { signal } },
              );
              if (!response.ok) throw new Error(await errorMessage(response, "Could not search Tables"));
              return ((await response.json()) as PublicTable[]).map((table) => ({
                id: table.id,
                label: table.name,
                description: `${table.kind === "federated" ? "Combined Table" : "Stored Table"} · ${table.id}`,
                icon: table.icon ?? "ti ti-table",
              }));
            }}
          />
        </Show>
        <TextInput
          label="Reason"
          description="Tell other administrators why this scope must be preserved."
          required
          multiline
          lines={3}
          maxLength={PRESERVATION_HOLD_REASON_MAX_LENGTH}
          value={reason}
          onValueChange={setReason}
        />
      </div>
      <footer class="k2b-dialog__actions">
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          Cancel
        </Button>
        <Button type="submit" disabled={!input()}>
          Create hold
        </Button>
      </footer>
    </form>
  );
};

export function PreservationHoldsSection(props: { baseId: string; onSavingChange: (saving: boolean) => void }) {
  let disposed = false;
  const holds = query.create({
    source: () => props.baseId,
    load: async (baseId, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"].$get(
        { param: { baseId }, query: { status: "active", page: "1", per_page: "100" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load preservation holds"));
      return (await response.json()) as PreservationHoldsResponse;
    },
  });

  const createHold = mutations.create<PreservationHold, CreatePreservationHoldInput>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"].$post(
        { param: { baseId: props.baseId }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not create preservation hold"));
      return response.json();
    },
    onSuccess: () => {
      toast.success("Preservation hold created");
      void holds
        .invalidate()
        .catch(() => !disposed && void prompts.error("The hold was created, but active holds could not be refreshed."));
    },
    onError: (error) => prompts.error(error.message),
  });

  const releaseHold = mutations.create<PreservationHold, { holdId: string; reason: string }>({
    mutation: async ({ holdId, reason }, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"][":holdId"].release.$post(
        { param: { baseId: props.baseId, holdId }, json: { reason } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not release preservation hold"));
      return response.json();
    },
    onSuccess: () => {
      toast.success("Preservation hold released");
      void holds
        .invalidate()
        .catch(() => !disposed && void prompts.error("The hold was released, but active holds could not be refreshed."));
    },
    onError: (error) => prompts.error(error.message),
  });

  const busy = () => createHold.loading() || releaseHold.loading();
  createEffect(() => props.onSavingChange(busy()));
  const create = async () => {
    const input = await prompts.dialog<CreatePreservationHoldInput>(
      (close) => <CreatePreservationHoldDialog baseId={props.baseId} close={close} />,
      { title: "Create preservation hold", icon: "ti ti-lock-plus", size: "medium" },
    );
    if (input) createHold.mutate(input);
  };
  const release = async (holdId: string) => {
    const result = await askReleaseReason();
    const reason = result?.reason.trim();
    if (reason) releaseHold.mutate({ holdId, reason });
  };
  onCleanup(() => {
    disposed = true;
    createHold.abort();
    releaseHold.abort();
    props.onSavingChange(false);
  });

  return (
    <>
      <InlineGuidance tone="info" icon="ti ti-info-circle">
        A Table hold also prevents deleting its parent Base, so the hold cannot be bypassed. Holds do not lock Records or change access.
      </InlineGuidance>
      <Show when={!holds.loading()} fallback={<Placeholder state="loading" variant="compact" title="Loading preservation holds" />}>
        <Show
          when={!holds.error()}
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              title="Preservation holds are unavailable"
              description={holds.error() instanceof Error ? holds.error()!.message : "Could not load preservation holds"}
              action={
                <Button size="sm" variant="secondary" onClick={() => void holds.refresh()}>
                  Retry
                </Button>
              }
            />
          }
        >
          <SettingsCollection
            class="mt-5"
            title={
              <span class="inline-flex items-center gap-2">
                <i class="ti ti-lock" aria-hidden="true" /> Active holds
              </span>
            }
            description="Every active hold must be released separately."
            empty="No active preservation holds."
          >
            <SettingsCollection.Action>
              <Button size="sm" variant="secondary" disabled={busy()} onClick={() => void create()}>
                <i class="ti ti-lock-plus" aria-hidden="true" /> Create hold
              </Button>
            </SettingsCollection.Action>
            <For each={holds.data()?.items ?? []}>
              {(hold) => {
                const scopeLabel = hold.scope.type === "base" ? "Entire Base" : hold.scope.tableName;
                const scopeDescription = hold.scope.type === "base" ? "Base" : `Table ${hold.scope.tableId}`;
                return (
                  <SettingsCollection.Item
                    title={scopeLabel}
                    description={`${hold.reason} · Created ${new Date(hold.createdAt).toLocaleString()}${hold.createdByDisplayName ? ` by ${hold.createdByDisplayName}` : ""} · ${hold.id}`}
                    icon={<i class={hold.scope.type === "base" ? "ti ti-database-lock" : "ti ti-table-lock"} aria-hidden="true" />}
                  >
                    <SettingsCollection.Item.Status>
                      <StatusBadge tone="neutral" variant="text" label={scopeDescription} icon={null} />
                    </SettingsCollection.Item.Status>
                    <SettingsCollection.Item.Actions>
                      <Button size="sm" variant="secondary" disabled={busy()} onClick={() => void release(hold.id)}>
                        Release
                      </Button>
                    </SettingsCollection.Item.Actions>
                  </SettingsCollection.Item>
                );
              }}
            </For>
          </SettingsCollection>
          <Show when={(holds.data()?.pagination.total ?? 0) > 100}>
            <p class="text-xs text-dimmed">Showing the newest 100 active holds. Use the CLI to page through the complete list.</p>
          </Show>
        </Show>
      </Show>
    </>
  );
}
