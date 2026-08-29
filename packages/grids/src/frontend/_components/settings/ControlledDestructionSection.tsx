import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  Disclosure,
  InlineGuidance,
  Placeholder,
  prompts,
  SettingsCollection,
  SettingsGroup,
  StatCell,
  StatGrid,
  StatusBadge,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ControlledDestructionOverview, ControlledDestructionRun } from "../../../controlled-destruction-contracts";
import { errorMessage } from "../utils/api-helpers";
import { useGridsSettingsMessages } from "./messages";

const active = (run: ControlledDestructionRun) => ["queued", "running", "cancel_requested"].includes(run.status);
const tone = (run: ControlledDestructionRun): "neutral" | "warning" | "ok" | "error" => {
  if (run.status === "completed") return "ok";
  if (["partial", "failed"].includes(run.status)) return "error";
  if (active(run)) return "warning";
  return "neutral";
};

export function ControlledDestructionSection(props: { baseId: string; baseName: string; onSavingChange: (saving: boolean) => void }) {
  const locale = useLocale();
  const messages = useGridsSettingsMessages(locale);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const bytes = (value: number) => {
    const format = (amount: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(amount);
    if (value < 1024) return `${format(value)} B`;
    if (value < 1024 * 1024) return `${format(value / 1024)} KB`;
    return `${format(value / (1024 * 1024))} MB`;
  };
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const statusLabel = (status: ControlledDestructionRun["status"]) =>
    ({
      queued: messages().statusQueued,
      running: messages().statusRunning,
      cancel_requested: messages().statusCancelRequested,
      completed: messages().statusCompleted,
      partial: messages().statusPartial,
      failed: messages().statusFailed,
      canceled: messages().statusCanceled,
    })[status];
  const [refresh, setRefresh] = createSignal(0);
  const overview = query.create({
    source: refresh,
    load: async (_, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["controlled-destruction"].$get(
        { param: { baseId: props.baseId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().destructionLoadFailed));
      return (await response.json()) as ControlledDestructionOverview;
    },
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => {
      if (overview.data()?.runs.some(active)) setRefresh((value) => value + 1);
    }, 3_000);
  });
  onCleanup(() => timer && clearInterval(timer));

  const start = mutation.create<ControlledDestructionRun, void>({
    mutation: async (_, { abortSignal }) => {
      const current = overview.data()?.preview;
      if (!current || current.items.length === 0) throw new Error(messages().refreshBeforeDestruction);
      const confirmed = await prompts.confirm(
        messages().destructionConfirm({
          count: number(current.items.length),
          size: bytes(current.items.reduce((sum, item) => sum + item.sizeBytes, 0)),
        }),
        {
          title: messages().destroyFileBytes,
          confirmText: messages().startDestruction,
          variant: "danger",
          confirmationPhrase: props.baseName,
        },
      );
      if (!confirmed) throw new DOMException("Canceled", "AbortError");
      const response = await apiClient.bases[":baseId"]["controlled-destruction"].$post(
        {
          param: { baseId: props.baseId },
          json: {
            fileIds: current.items.map((item) => item.fileId),
            confirmation: props.baseName,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().destructionStartFailed));
      return (await response.json()) as ControlledDestructionRun;
    },
    onSuccess: () => {
      toast.success(messages().destructionStarted);
      setRefresh((value) => value + 1);
    },
    onError: (error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) prompts.error(error.message);
    },
  });

  const cancel = mutation.create<ControlledDestructionRun, string>({
    mutation: async (runId, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().cancelDestructionWarning, {
        title: messages().cancelRemainingDestruction,
        confirmText: messages().cancelRemainingWork,
        variant: "danger",
      });
      if (!confirmed) throw new DOMException("Canceled", "AbortError");
      const response = await apiClient.bases[":baseId"]["controlled-destruction"][":runId"].cancel.$post(
        { param: { baseId: props.baseId, runId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().destructionCancelFailed));
      return (await response.json()) as ControlledDestructionRun;
    },
    onSuccess: () => setRefresh((value) => value + 1),
    onError: (error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) prompts.error(error.message);
    },
  });
  const saving = () => start.loading() || cancel.loading();
  createEffect(() => props.onSavingChange(saving()));
  onCleanup(() => {
    start.abort();
    cancel.abort();
    props.onSavingChange(false);
  });

  return (
    <SettingsGroup title={messages().controlledFileDestruction} description={messages().controlledFileDestructionDescription}>
      <SettingsGroup.Action>
        <Button size="sm" variant="secondary" disabled={overview.loading() || saving()} onClick={() => setRefresh((value) => value + 1)}>
          {messages().refresh}
        </Button>
      </SettingsGroup.Action>
      <Show
        when={!overview.loading()}
        fallback={<Placeholder state="loading" variant="compact" title={messages().loadingDestructionPreview} />}
      >
        <Show
          when={!overview.error()}
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              title={messages().destructionUnavailable}
              description={overview.error() instanceof Error ? overview.error()!.message : messages().destructionLoadFailed}
              action={
                <Button size="sm" variant="secondary" onClick={() => setRefresh((value) => value + 1)}>
                  {messages().retry}
                </Button>
              }
            />
          }
        >
          <Show when={overview.data()} keyed>
            {(value) => (
              <>
                <InlineGuidance tone="danger" icon="ti ti-alert-triangle">
                  {messages().destructionGuidance}
                </InlineGuidance>
                <StatGrid columns={4} size="sm" surface="muted">
                  <StatCell
                    label={messages().eligibleFiles}
                    value={number(value.preview.counts.eligible)}
                    sub={bytes(value.preview.counts.eligibleBytes)}
                  />
                  <StatCell label={messages().retained} value={number(value.preview.counts.retained)} sub={messages().floorNotReached} />
                  <StatCell label={messages().held} value={number(value.preview.counts.held)} sub={messages().preservationHold} />
                  <StatCell label={messages().protected} value={number(value.preview.counts.unknown)} sub={messages().unknownOrProtected} />
                </StatGrid>
                <div class="flex items-center justify-between gap-3">
                  <p class="text-xs text-dimmed">
                    {messages().destructionPreviewSummary({
                      date: dateTime(value.preview.observedAt),
                      shown: number(value.preview.items.length),
                      eligible: number(value.preview.counts.eligible),
                    })}
                  </p>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={saving() || value.preview.items.length === 0}
                    onClick={() => start.mutate(undefined)}
                  >
                    {messages().destroyEligibleFiles}
                  </Button>
                </div>
                <Show when={value.preview.items.length > 0}>
                  <Disclosure summary={messages().filesInNextRun({ count: number(value.preview.items.length) })}>
                    <SettingsCollection title={messages().exactCandidates}>
                      <For each={value.preview.items}>
                        {(item) => (
                          <SettingsCollection.Item
                            title={item.filename}
                            description={messages().eligibleFileDescription({
                              table: item.tableName,
                              tableId: item.tableId,
                              fileId: item.fileId,
                              date: dateTime(item.notBefore),
                            })}
                            icon={<i class="ti ti-paperclip" aria-hidden="true" />}
                          >
                            <SettingsCollection.Item.Status>
                              <StatusBadge tone="warning" label={bytes(item.sizeBytes)} icon={null} />
                            </SettingsCollection.Item.Status>
                          </SettingsCollection.Item>
                        )}
                      </For>
                    </SettingsCollection>
                  </Disclosure>
                </Show>
                <SettingsCollection title={messages().recentDestructionRuns} empty={messages().noDestructionRuns}>
                  <For each={value.runs}>
                    {(run) => (
                      <SettingsCollection.Item
                        title={messages().runTitle({ id: run.id })}
                        description={messages().runDescription({
                          destroyed: number(run.counts.destroyed),
                          skipped: number(run.counts.skipped),
                          failed: number(run.counts.failed),
                          date: dateTime(run.requestedAt),
                          by: run.requestedByDisplayName ?? "",
                        })}
                        icon={<i class="ti ti-trash-x" aria-hidden="true" />}
                      >
                        <SettingsCollection.Item.Status>
                          <StatusBadge tone={tone(run)} label={statusLabel(run.status)} icon={null} />
                        </SettingsCollection.Item.Status>
                        <Show when={active(run) && run.status !== "cancel_requested"}>
                          <SettingsCollection.Item.Actions>
                            <Button size="sm" variant="secondary" disabled={saving()} onClick={() => cancel.mutate(run.id)}>
                              {messages().cancelRemaining}
                            </Button>
                          </SettingsCollection.Item.Actions>
                        </Show>
                      </SettingsCollection.Item>
                    )}
                  </For>
                </SettingsCollection>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </SettingsGroup>
  );
}
