import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  InlineGuidance,
  NumberInput,
  Placeholder,
  prompts,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  StatCell,
  StatGrid,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, type RetentionPolicy, type RetentionPreview } from "../../../retention-policy-contracts";
import { errorMessage } from "../utils/api-helpers";
import { useGridsSettingsMessages } from "./messages";
import { openRetentionFilesDialog } from "./RetentionFilesDialog";
import { openRetentionRecordsDialog } from "./RetentionRecordsDialog";

export function RetentionPolicySection(props: {
  baseId: string;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
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
  const policy = query.create({
    source: () => props.baseId,
    load: async (baseId, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"]["retention-policy"].$get({ param: { baseId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, messages().retentionPolicyLoadFailed));
      return (await response.json()).policy as RetentionPolicy | null;
    },
  });
  const [days, setDays] = createSignal<number | null>(null);
  const [savedDays, setSavedDays] = createSignal<number | null>(null);
  const [initialized, setInitialized] = createSignal(false);
  createEffect(() => {
    if (!policy.loading() && !policy.error() && !initialized()) {
      setDays(policy.data()?.minimumDays ?? null);
      setSavedDays(policy.data()?.minimumDays ?? null);
      setInitialized(true);
    }
  });
  const validDays = () => days() !== null && days()! >= RETENTION_MIN_DAYS && days()! <= RETENTION_MAX_DAYS;
  const changed = createMemo(() => initialized() && days() !== savedDays());
  createEffect(() => props.onDirtyChange(changed()));
  onCleanup(() => props.onDirtyChange(false));

  const preview = query.create({
    source: () => (validDays() ? days() : null),
    load: async (minimumDays, { abortSignal }) => {
      if (minimumDays === null) return null;
      const response = await apiClient.bases[":baseId"]["retention-policy"].preview.$post(
        { param: { baseId: props.baseId }, json: { minimumDays } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().retentionPreviewFailed));
      return { minimumDays, value: (await response.json()) as RetentionPreview };
    },
  });
  const currentPreview = () => {
    const loaded = preview.data();
    return loaded?.minimumDays === days() ? loaded.value : null;
  };

  const save = mutations.create<RetentionPolicy, void>({
    mutation: async (_, { abortSignal }) => {
      const minimumDays = days();
      if (minimumDays === null) throw new Error(messages().enterMinimumDays);
      if (savedDays() !== null && minimumDays < savedDays()!) {
        const confirmed = await prompts.confirm(messages().shortenFloorWarning, {
          title: messages().shortenMinimumRetention,
          confirmText: messages().shortenFloor,
        });
        if (!confirmed) throw new DOMException("Canceled", "AbortError");
      }
      const response = await apiClient.bases[":baseId"]["retention-policy"].$put(
        { param: { baseId: props.baseId }, json: { minimumDays } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().retentionSaveFailed));
      return (await response.json()).policy as RetentionPolicy;
    },
    onSuccess: (next) => {
      setSavedDays(next.minimumDays);
      setDays(next.minimumDays);
      void policy.invalidate();
      toast.success(messages().minimumRetentionSaved);
    },
    onError: (error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) prompts.error(error.message);
    },
  });

  const remove = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().removeFloorWarning, {
        title: messages().removeMinimumRetention,
        confirmText: messages().removeFloor,
      });
      if (!confirmed) throw new DOMException("Canceled", "AbortError");
      const response = await apiClient.bases[":baseId"]["retention-policy"].$delete(
        { param: { baseId: props.baseId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, messages().retentionRemoveFailed));
    },
    onSuccess: () => {
      setSavedDays(null);
      setDays(null);
      void policy.invalidate();
      toast.success(messages().minimumRetentionRemoved);
    },
    onError: (error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) prompts.error(error.message);
    },
  });
  const saving = () => save.loading() || remove.loading();
  createEffect(() => props.onSavingChange(saving()));
  onCleanup(() => props.onSavingChange(false));

  return (
    <>
      <SettingsGroup title={messages().baseRetentionFloor} description={messages().baseRetentionFloorDescription}>
        <SettingsGroup.Action>
          <Show when={savedDays() !== null}>
            <Button variant="secondary" size="sm" disabled={saving()} onClick={() => remove.mutate(undefined)}>
              {messages().removeFloor}
            </Button>
          </Show>
        </SettingsGroup.Action>
        <InlineGuidance tone="info" icon="ti ti-info-circle">
          {messages().retentionFloorGuidance}
        </InlineGuidance>
        <Show
          when={!policy.loading()}
          fallback={<Placeholder state="loading" variant="compact" title={messages().loadingRetentionPolicy} />}
        >
          <Show
            when={!policy.error()}
            fallback={
              <Placeholder
                state="error"
                variant="compact"
                title={messages().retentionPolicyUnavailable}
                description={policy.error() instanceof Error ? policy.error()!.message : messages().retentionPolicyLoadFailed}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void policy.invalidate()}>
                    {messages().retry}
                  </Button>
                }
              />
            }
          >
            <NumberInput
              label={messages().minimumRetentionDays}
              description={messages().minimumRetentionDaysDescription}
              min={RETENTION_MIN_DAYS}
              max={RETENTION_MAX_DAYS}
              step={1}
              clearable
              value={days}
              onValueChange={setDays}
              disabled={saving()}
            />
            <Show when={days() === null}>
              <p class="text-sm text-muted">{savedDays() === null ? messages().noMinimumRetention : messages().emptyRetentionDraft}</p>
            </Show>
            <Show when={validDays() && preview.loading()}>
              <Placeholder state="loading" variant="compact" title={messages().calculatingImpact} />
            </Show>
            <Show when={preview.error()}>
              <Placeholder
                state="error"
                variant="compact"
                title={messages().impactUnavailable}
                description={preview.error() instanceof Error ? preview.error()!.message : messages().previewFailed}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void preview.invalidate()}>
                    {messages().retry}
                  </Button>
                }
              />
            </Show>
            <Show when={currentPreview()} keyed>
              {(impact) => (
                <div class="space-y-3">
                  <StatGrid title={messages().retentionPreview} columns={3} size="sm" surface="muted">
                    <StatCell
                      label={messages().recordsRetained}
                      value={number(impact.counts.retainedUntilLater)}
                      sub={messages().untilLater}
                    />
                    <StatCell
                      label={messages().recordsAtFloor}
                      value={number(impact.counts.floorReached)}
                      sub={messages().noDestructionPerformed}
                    />
                    <StatCell
                      label={messages().finalizedRecords}
                      value={number(impact.counts.protectedFinalized)}
                      sub={messages().protectedIndependently}
                    />
                    <StatCell
                      label={messages().filesRetained}
                      value={number(impact.files.counts.retainedUntilLater)}
                      sub={messages().untilLater}
                    />
                    <StatCell
                      label={messages().filesAtFloor}
                      value={number(impact.files.counts.floorReached)}
                      sub={messages().protectedReferencesExcluded}
                    />
                    <StatCell
                      label={messages().unreferencedStorage}
                      value={bytes(impact.files.counts.sizeBytes)}
                      sub={messages().fileCount({ count: number(impact.files.counts.unreferenced) })}
                    />
                  </StatGrid>
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <p class="text-xs text-dimmed">
                      {changed()
                        ? messages().calculatedUnsavedFloor({ date: dateTime(impact.observedAt), days: number(days()!) })
                        : messages().calculatedAt({ date: dateTime(impact.observedAt) })}
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={impact.counts.trashedRecords === 0}
                        onClick={() => void openRetentionRecordsDialog(props.baseId, impact.minimumDays)}
                      >
                        {messages().reviewRecords}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={impact.files.counts.unreferenced === 0}
                        onClick={() => void openRetentionFilesDialog(props.baseId, impact.minimumDays)}
                      >
                        {messages().reviewFiles}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </Show>
          </Show>
        </Show>
      </SettingsGroup>
      <SettingsModal.Footer>
        <SettingsPanelFooter
          changeCount={() => (changed() ? 1 : 0)}
          loading={saving}
          saveDisabled={() => !validDays()}
          onDiscard={() => setDays(savedDays())}
          onSave={() => save.mutate(undefined)}
        />
      </SettingsModal.Footer>
    </>
  );
}
