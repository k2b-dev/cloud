import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  dialogCore,
  InlineGuidance,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  SettingsCollection,
  StatusBadge,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
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

export const CreatePreservationHoldDialog = (props: {
  baseId: string;
  close: () => void;
  save: (input: CreatePreservationHoldInput) => Promise<void>;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
}) => {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const [scope, setScope] = createSignal<"base" | "table">("base");
  const [tableId, setTableId] = createSignal<string | null>(null);
  const [reason, setReason] = createSignal("");
  const input = () => buildPreservationHoldInput(scope(), tableId(), reason());
  const save = mutations.create({ mutation: props.save, onSuccess: props.close });
  const dismiss = async () => {
    if (!save.loading() && (await confirmDiscardIfDirty(reason().length > 0 || scope() !== "base"))) props.close();
  };
  props.setDismissHandler(dismiss);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const value = input();
        if (value && !save.loading()) void save.mutate(value);
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={messages().createPreservationHold}
          icon="ti ti-lock-plus"
          close={dismiss}
          closeDisabled={save.loading()}
        />
        <PanelDialog.Body>
          <div class="flex flex-col gap-4">
            <Show when={save.error()}>{(error) => <InlineGuidance tone="danger">{error().message}</InlineGuidance>}</Show>
            <p>{messages().holdScopeExplanation}</p>
            <Select
              label={messages().scope}
              description={messages().holdScopeDescription}
              required
              disabled={save.loading()}
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
                disabled={save.loading()}
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
              disabled={save.loading()}
              multiline
              lines={3}
              maxLength={PRESERVATION_HOLD_REASON_MAX_LENGTH}
              value={reason}
              onValueChange={setReason}
            />
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span />
          <div class="flex gap-2">
            <Button type="button" variant="secondary" onClick={dismiss} disabled={save.loading()}>
              {messages().cancel}
            </Button>
            <Button type="submit" disabled={!input()} loading={save.loading()}>
              {messages().createHold}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
};

export function PreservationHoldsSection(props: { baseId: string; onSavingChange: (saving: boolean) => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  let disposed = false;
  const [page, setPage] = createSignal(1);
  const [search, setSearch] = createSignal("");
  const source = createMemo(() => ({ baseId: props.baseId, page: page(), search: search().trim() }));
  const holds = query.create({
    source,
    load: async ({ baseId, page, search }, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["preservation-holds"].$get(
        { param: { baseId }, query: { status: "active", page: String(page), per_page: "25", q: search } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().loadHoldsFailed));
      const result = (await response.json()) as PreservationHoldsResponse;
      return { ...result, requestedPage: page, requestedSearch: search };
    },
  });
  createEffect(() => {
    const result = holds.data();
    if (result?.requestedPage !== page() || result.requestedSearch !== search().trim()) return;
    const lastPage = Math.max(1, result.pagination.total_pages);
    if (page() > lastPage) setPage(lastPage);
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
  });

  const busy = () => createHold.loading() || releaseHold.loading();
  createEffect(() => props.onSavingChange(busy()));
  const create = async () => {
    await dialogCore.open<void>(
      (close, context) => (
        <CreatePreservationHoldDialog
          baseId={props.baseId}
          close={close}
          setDismissHandler={context.setDismissHandler}
          save={async (input) => {
            await createHold.mutate(input);
            if (createHold.error()) throw createHold.error();
          }}
        />
      ),
      panelDialogOptions,
    );
  };
  const release = async (holdId: string) => {
    await dialogCore.open<void>((close, context) => {
      const [reason, setReason] = createSignal("");
      const save = mutations.create({
        mutation: async () => {
          await releaseHold.mutate({ holdId, reason: reason().trim() });
          if (releaseHold.error()) throw releaseHold.error();
        },
        onSuccess: close,
      });
      const dismiss = async () => {
        if (!save.loading() && (await confirmDiscardIfDirty(reason().length > 0))) close();
      };
      context.setDismissHandler(dismiss);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (reason().trim() && !save.loading()) void save.mutate(undefined);
          }}
        >
          <PanelDialog>
            <PanelDialog.Header title={messages().releaseHoldTitle} icon="ti ti-lock-open" close={dismiss} closeDisabled={save.loading()} />
            <PanelDialog.Body>
              <div class="flex flex-col gap-4">
                <p>{messages().releaseHoldExplanation}</p>
                <Show when={save.error()}>{(error) => <InlineGuidance tone="danger">{error().message}</InlineGuidance>}</Show>
                <TextInput
                  label={messages().reason}
                  description={messages().releaseHoldReason}
                  value={reason}
                  onValueChange={setReason}
                  required
                  multiline
                  lines={3}
                  maxLength={PRESERVATION_HOLD_REASON_MAX_LENGTH}
                  disabled={save.loading()}
                />
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <span />
              <div class="flex gap-2">
                <Button type="button" variant="secondary" disabled={save.loading()} onClick={dismiss}>
                  {messages().cancel}
                </Button>
                <Button type="submit" variant="danger" disabled={!reason().trim()} loading={save.loading()}>
                  {messages().releaseHold}
                </Button>
              </div>
            </PanelDialog.Footer>
          </PanelDialog>
        </form>
      );
    }, panelDialogOptions);
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
      <TextInput
        type="search"
        label={messages().searchHolds}
        placeholder={messages().searchHoldsPlaceholder}
        icon="ti ti-search"
        value={search}
        maxLength={200}
        onValueChange={(value) => {
          setPage(1);
          setSearch(value);
        }}
      />
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
            empty={search().trim() ? messages().noMatchingHolds : messages().noActiveHolds}
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
                      <Button size="sm" variant="secondary" disabled={busy() || holds.refreshing()} onClick={() => void release(hold.id)}>
                        {messages().release}
                      </Button>
                    </SettingsCollection.Item.Actions>
                  </SettingsCollection.Item>
                );
              }}
            </For>
          </SettingsCollection>
          <Show when={holds.refreshing()}>
            <Placeholder state="loading" variant="compact" title={messages().loadingHolds} />
          </Show>
          <Show when={(holds.data()?.pagination.total_pages ?? 1) > 1}>
            <div class="flex items-center justify-between gap-3">
              <Button size="sm" variant="secondary" disabled={page() <= 1 || holds.refreshing()} onClick={() => setPage(page() - 1)}>
                {messages().previous}
              </Button>
              <span class="text-xs text-dimmed">
                {messages().pageOf({ page: String(page()), total: String(holds.data()?.pagination.total_pages ?? 1) })}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={page() >= (holds.data()?.pagination.total_pages ?? 1) || holds.refreshing()}
                onClick={() => setPage(page() + 1)}
              >
                {messages().next}
              </Button>
            </div>
          </Show>
        </Show>
      </Show>
    </>
  );
}
