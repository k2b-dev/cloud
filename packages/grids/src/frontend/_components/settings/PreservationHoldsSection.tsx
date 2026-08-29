import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  InlineGuidance,
  Placeholder,
  prompts,
  Select,
  SettingsCollection,
  StatusBadge,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
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
import { useGridsSettingsMessages } from "./messages";

const askReleaseReason = (messages: ReturnType<ReturnType<typeof useGridsSettingsMessages>>) =>
  prompts.form({
    title: messages.releaseHoldTitle,
    icon: "ti ti-lock-open",
    fields: {
      explanation: {
        type: "info" as const,
        content: messages.releaseHoldExplanation,
      },
      reason: {
        type: "text" as const,
        label: messages.reason,
        description: messages.releaseHoldReason,
        required: true,
        multiline: true,
        lines: 3,
        maxLength: PRESERVATION_HOLD_REASON_MAX_LENGTH,
      },
    },
    confirmText: messages.releaseHold,
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
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
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
        <p>{messages().holdScopeExplanation}</p>
        <Select
          label={messages().scope}
          description={messages().holdScopeDescription}
          required
          value={scope}
          onValueChange={(value) => {
            setScope(value === "table" ? "table" : "base");
            if (value !== "table") setTableId(null);
          }}
          options={[
            { id: "base", label: messages().entireBase, description: messages().entireBaseHoldDescription },
            {
              id: "table",
              label: messages().oneTable,
              description: messages().oneTableHoldDescription,
            },
          ]}
        />
        <Show when={scope() === "table"}>
          <Select
            label={messages().table}
            description={messages().searchActiveTables}
            placeholder={messages().searchTablesPlaceholder}
            required
            value={tableId}
            onValueChange={setTableId}
            fetchData={async (search, signal) => {
              const response = await apiClient.tables["by-base"][":baseId"].$get(
                { param: { baseId: props.baseId }, query: { q: search, limit: "25" } },
                { init: { signal } },
              );
              if (!response.ok) throw new Error(await errorMessage(response, messages().searchTablesFailed));
              return ((await response.json()) as PublicTable[]).map((table) => ({
                id: table.id,
                label: table.name,
                description: `${table.kind === "federated" ? messages().combinedTable : messages().storedTable} · ${table.id}`,
                icon: table.icon ?? "ti ti-table",
              }));
            }}
          />
        </Show>
        <TextInput
          label={messages().reason}
          description={messages().holdReasonDescription}
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
          {messages().cancel}
        </Button>
        <Button type="submit" disabled={!input()}>
          {messages().createHold}
        </Button>
      </footer>
    </form>
  );
};

export function PreservationHoldsSection(props: { baseId: string; onSavingChange: (saving: boolean) => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  let disposed = false;
  const holds = query.create({
    source: () => props.baseId,
    load: async (baseId, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"].$get(
        { param: { baseId }, query: { status: "active", page: "1", per_page: "100" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().loadHoldsFailed));
      return (await response.json()) as PreservationHoldsResponse;
    },
  });

  const createHold = mutations.create<PreservationHold, CreatePreservationHoldInput>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"].$post(
        { param: { baseId: props.baseId }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().createHoldFailed));
      return response.json();
    },
    onSuccess: () => {
      toast.success(messages().holdCreated);
      void holds.invalidate().catch(() => !disposed && void prompts.error(messages().holdCreatedRefreshFailed));
    },
    onError: (error) => prompts.error(error.message),
  });

  const releaseHold = mutations.create<PreservationHold, { holdId: string; reason: string }>({
    mutation: async ({ holdId, reason }, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"][":holdId"].release.$post(
        { param: { baseId: props.baseId, holdId }, json: { reason } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().releaseHoldFailed));
      return response.json();
    },
    onSuccess: () => {
      toast.success(messages().holdReleased);
      void holds.invalidate().catch(() => !disposed && void prompts.error(messages().holdReleasedRefreshFailed));
    },
    onError: (error) => prompts.error(error.message),
  });

  const busy = () => createHold.loading() || releaseHold.loading();
  createEffect(() => props.onSavingChange(busy()));
  const create = async () => {
    const input = await prompts.dialog<CreatePreservationHoldInput>(
      (close) => <CreatePreservationHoldDialog baseId={props.baseId} close={close} />,
      { title: messages().createPreservationHold, icon: "ti ti-lock-plus", size: "medium" },
    );
    if (input) createHold.mutate(input);
  };
  const release = async (holdId: string) => {
    const result = await askReleaseReason(messages());
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
        {messages().holdsGuidance}
      </InlineGuidance>
      <Show when={!holds.loading()} fallback={<Placeholder state="loading" variant="compact" title={messages().loadingHolds} />}>
        <Show
          when={!holds.error()}
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              title={messages().holdsUnavailable}
              description={holds.error() instanceof Error ? holds.error()!.message : messages().loadHoldsFailed}
              action={
                <Button size="sm" variant="secondary" onClick={() => void holds.refresh()}>
                  {messages().retry}
                </Button>
              }
            />
          }
        >
          <SettingsCollection
            class="mt-5"
            title={
              <span class="inline-flex items-center gap-2">
                <i class="ti ti-lock" aria-hidden="true" /> {messages().activeHolds}
              </span>
            }
            description={messages().activeHoldsDescription}
            empty={messages().noActiveHolds}
          >
            <SettingsCollection.Action>
              <Button size="sm" variant="secondary" disabled={busy()} onClick={() => void create()}>
                <i class="ti ti-lock-plus" aria-hidden="true" /> {messages().createHold}
              </Button>
            </SettingsCollection.Action>
            <For each={holds.data()?.items ?? []}>
              {(hold) => {
                const scopeLabel = hold.scope.type === "base" ? messages().entireBase : hold.scope.tableName;
                const scopeDescription = hold.scope.type === "base" ? messages().base : messages().tableWithId({ id: hold.scope.tableId });
                return (
                  <SettingsCollection.Item
                    title={scopeLabel}
                    description={messages().holdCreatedDescription({
                      reason: hold.reason,
                      date: dateTime(hold.createdAt),
                      by: hold.createdByDisplayName ?? "",
                      id: hold.id,
                    })}
                    icon={<i class={hold.scope.type === "base" ? "ti ti-database" : "ti ti-table"} aria-hidden="true" />}
                  >
                    <SettingsCollection.Item.Status>
                      <StatusBadge tone="neutral" variant="text" label={scopeDescription} icon={null} />
                    </SettingsCollection.Item.Status>
                    <SettingsCollection.Item.Actions>
                      <Button size="sm" variant="secondary" disabled={busy()} onClick={() => void release(hold.id)}>
                        {messages().release}
                      </Button>
                    </SettingsCollection.Item.Actions>
                  </SettingsCollection.Item>
                );
              }}
            </For>
          </SettingsCollection>
          <Show when={(holds.data()?.pagination.total ?? 0) > 100}>
            <p class="text-xs text-dimmed">{messages().newestHoldsCli}</p>
          </Show>
        </Show>
      </Show>
    </>
  );
}
