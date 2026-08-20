import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  Disclosure,
  formatFileViewSize,
  InlineGuidance,
  Placeholder,
  prompts,
  SettingsCollection,
  SettingsGroup,
  StatCell,
  StatGrid,
  StatusBadge,
  toast,
} from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ControlledDestructionOverview, ControlledDestructionRun } from "../../../controlled-destruction-contracts";
import { errorMessage } from "../utils/api-helpers";

const active = (run: ControlledDestructionRun) => ["queued", "running", "cancel_requested"].includes(run.status);
const tone = (run: ControlledDestructionRun): "neutral" | "warning" | "ok" | "error" => {
  if (run.status === "completed") return "ok";
  if (["partial", "failed"].includes(run.status)) return "error";
  if (active(run)) return "warning";
  return "neutral";
};

export function ControlledDestructionSection(props: { baseId: string; baseName: string; onSavingChange: (saving: boolean) => void }) {
  const [refresh, setRefresh] = createSignal(0);
  const overview = query.create({
    source: refresh,
    load: async (_, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["controlled-destruction"].$get(
        { param: { baseId: props.baseId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load controlled destruction"));
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
      if (!current || current.items.length === 0) throw new Error("Refresh the preview before starting destruction.");
      const confirmed = await prompts.confirm(
        `This permanently removes ${current.items.length} unreferenced File${current.items.length === 1 ? "" : "s"} (${formatFileViewSize(current.items.reduce((sum, item) => sum + item.sizeBytes, 0))}). Eligibility and holds are checked again before every File.`,
        {
          title: "Destroy unreferenced File bytes?",
          confirmText: "Start destruction",
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
      if (!response.ok) throw new Error(await errorMessage(response, "Could not start controlled destruction"));
      return (await response.json()) as ControlledDestructionRun;
    },
    onSuccess: () => {
      toast.success("Controlled destruction started");
      setRefresh((value) => value + 1);
    },
    onError: (error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) prompts.error(error.message);
    },
  });

  const cancel = mutation.create<ControlledDestructionRun, string>({
    mutation: async (runId, { abortSignal }) => {
      const confirmed = await prompts.confirm("Only remaining work is canceled. File bytes already destroyed cannot be recovered.", {
        title: "Cancel remaining destruction?",
        confirmText: "Cancel remaining work",
        variant: "danger",
      });
      if (!confirmed) throw new DOMException("Canceled", "AbortError");
      const response = await apiClient.bases[":baseId"]["controlled-destruction"][":runId"].cancel.$post(
        { param: { baseId: props.baseId, runId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not cancel controlled destruction"));
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
    <SettingsGroup
      title="Controlled File destruction"
      description="Manually remove only unreferenced File bytes whose retention floor has been reached. Records and evidence artifacts are never included."
    >
      <SettingsGroup.Action>
        <Button size="sm" variant="secondary" disabled={overview.loading() || saving()} onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </Button>
      </SettingsGroup.Action>
      <Show when={!overview.loading()} fallback={<Placeholder state="loading" variant="compact" title="Loading destruction preview" />}>
        <Show
          when={!overview.error()}
          fallback={
            <Placeholder
              state="error"
              variant="compact"
              title="Controlled destruction is unavailable"
              description={overview.error() instanceof Error ? overview.error()!.message : "Could not load controlled destruction"}
              action={
                <Button size="sm" variant="secondary" onClick={() => setRefresh((value) => value + 1)}>
                  Retry
                </Button>
              }
            />
          }
        >
          <Show when={overview.data()} keyed>
            {(value) => (
              <>
                <InlineGuidance tone="danger" icon="ti ti-alert-triangle">
                  Destruction is permanent. Every File is rechecked before removal; Records and evidence artifacts are never included.
                </InlineGuidance>
                <StatGrid columns={4} size="sm" surface="muted">
                  <StatCell
                    label="Eligible Files"
                    value={value.preview.counts.eligible}
                    sub={formatFileViewSize(value.preview.counts.eligibleBytes)}
                  />
                  <StatCell label="Retained" value={value.preview.counts.retained} sub="Floor not reached" />
                  <StatCell label="Held" value={value.preview.counts.held} sub="Preservation hold" />
                  <StatCell label="Protected" value={value.preview.counts.unknown} sub="Unknown or protected" />
                </StatGrid>
                <div class="flex items-center justify-between gap-3">
                  <p class="text-xs text-dimmed">
                    Calculated {new Date(value.preview.observedAt).toLocaleString()}. The next run contains {value.preview.items.length} of{" "}
                    {value.preview.counts.eligible} eligible Files, at most 100.
                  </p>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={saving() || value.preview.items.length === 0}
                    onClick={() => start.mutate(undefined)}
                  >
                    Destroy eligible Files
                  </Button>
                </div>
                <Show when={value.preview.items.length > 0}>
                  <Disclosure summary={`Files in next run (${value.preview.items.length})`}>
                    <SettingsCollection title="Exact candidates">
                      <For each={value.preview.items}>
                        {(item) => (
                          <SettingsCollection.Item
                            title={item.filename}
                            description={`${item.tableName} (${item.tableId}) · File ${item.fileId} · eligible since ${new Date(item.notBefore).toLocaleString()}`}
                            icon={<i class="ti ti-paperclip" aria-hidden="true" />}
                          >
                            <SettingsCollection.Item.Status>
                              <StatusBadge tone="warning" label={formatFileViewSize(item.sizeBytes)} icon={null} />
                            </SettingsCollection.Item.Status>
                          </SettingsCollection.Item>
                        )}
                      </For>
                    </SettingsCollection>
                  </Disclosure>
                </Show>
                <SettingsCollection title="Recent destruction runs" empty="No controlled destruction runs yet.">
                  <For each={value.runs}>
                    {(run) => (
                      <SettingsCollection.Item
                        title={`Run ${run.id}`}
                        description={`${run.counts.destroyed} destroyed · ${run.counts.skipped} skipped · ${run.counts.failed} failed · requested ${new Date(run.requestedAt).toLocaleString()}${run.requestedByDisplayName ? ` by ${run.requestedByDisplayName}` : ""}`}
                        icon={<i class="ti ti-trash-x" aria-hidden="true" />}
                      >
                        <SettingsCollection.Item.Status>
                          <StatusBadge tone={tone(run)} label={run.status.replaceAll("_", " ")} icon={null} />
                        </SettingsCollection.Item.Status>
                        <Show when={active(run) && run.status !== "cancel_requested"}>
                          <SettingsCollection.Item.Actions>
                            <Button size="sm" variant="secondary" disabled={saving()} onClick={() => cancel.mutate(run.id)}>
                              Cancel remaining
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
