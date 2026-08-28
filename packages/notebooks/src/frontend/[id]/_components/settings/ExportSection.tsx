import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CheckboxCard,
  LogEntriesTable,
  type LogTableEntry,
  NoticeCard,
  Placeholder,
  prompts,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { type Accessor, createEffect, createSignal, onCleanup, type Setter, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { Notebook } from "../sidebar/types";
import type { BackupRunResult, BackupStatus } from "./types";
import { backupDraftFromStatus, backupDraftIsDirty, readErrorMessage, snapshotLogEntryFromRun } from "./utils";
import { notebookSettingsMessages } from "./messages";

function SnapshotUploadAction(props: {
  enabled: boolean;
  configured: boolean;
  loading: boolean;
  disabled: boolean;
  lastRun: BackupRunResult | null;
  onRun: () => void;
}) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  return (
    <Show when={props.enabled}>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={props.disabled || !props.configured}
          onClick={props.onRun}
          loading={props.loading}
          loadingLabel={t().uploading}
        >
          <Show when={!props.loading} fallback={<i class="ti ti-loader-2 animate-spin" />}>
            <i class="ti ti-cloud-upload" />
            {t().uploadNow}
          </Show>
        </Button>
        <Show when={props.lastRun}>
          {(result) => <span class="text-xs text-emerald-600 dark:text-emerald-300">{t().uploadedKb({ size: Math.round(result().bytes / 1024) })}</span>}
        </Show>
      </div>
    </Show>
  );
}

function SnapshotConfigFields(props: {
  notebookShortId: string;
  enabled: Accessor<boolean>;
  setEnabled: Setter<boolean>;
  endpoint: Accessor<string>;
  setEndpoint: Setter<string>;
  region: Accessor<string>;
  setRegion: Setter<string>;
  bucket: Accessor<string>;
  setBucket: Setter<string>;
  accessKeyId: Accessor<string>;
  setAccessKeyId: Setter<string>;
  secretAccessKey: Accessor<string>;
  setSecretAccessKey: Setter<string>;
  status: BackupStatus | undefined;
  missing: string;
  saving: boolean;
}) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  return (
    <>
      <CheckboxCard
        label={t().enableSnapshots}
        description={t().enableSnapshotsDescription}
        icon="ti ti-cloud-upload"
        value={props.enabled}
        onValueChange={props.setEnabled}
        disabled={props.saving}
      />

      <NoticeCard tone="info" icon={false}>
        {t().automaticSchedule}: <span class="font-mono text-primary">{props.status?.scheduleCron ?? "0 3 * * *"}</span>
        <span class="ml-2 text-dimmed">{t().scheduleAdminHint}</span>
      </NoticeCard>

      <Show when={props.enabled()}>
        <div class="grid gap-2">
          <TextInput
            label={t().endpoint}
            value={props.endpoint}
            onValueChange={props.setEndpoint}
            placeholder="https://..."
            icon="ti ti-link"
            type="url"
          />
          <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
            <i class="ti ti-info-circle mt-0.5 shrink-0" />
            <div>
              <p class="font-medium text-primary">{t().s3Endpoint}</p>
              <p class="mt-0.5 text-dimmed">{t().s3EndpointDescription} <code>notebooks/{props.notebookShortId}/</code></p>
            </div>
          </NoticeCard>
          <div class="grid gap-2 md:grid-cols-2">
            <TextInput label={t().region} value={props.region} onValueChange={props.setRegion} placeholder="eu-central-1" icon="ti ti-map" />
            <TextInput
              label={t().bucket}
              value={props.bucket}
              onValueChange={props.setBucket}
              placeholder="my-notebook-backups"
              icon="ti ti-bucket"
            />
          </div>
          <div class="grid gap-2 md:grid-cols-2">
            <TextInput
              label={t().accessKeyId}
              value={props.accessKeyId}
              onValueChange={props.setAccessKeyId}
              placeholder={props.status?.accessKeyIdSet ? t().storedKeep : ""}
              icon="ti ti-key"
            />
            <TextInput
              label={t().secretAccessKey}
              value={props.secretAccessKey}
              onValueChange={props.setSecretAccessKey}
              placeholder={props.status?.secretAccessKeySet ? t().storedKeep : ""}
              icon="ti ti-lock"
              password
            />
          </div>
          <NoticeCard tone="info" icon={false}>
            {t().target}: <span class="font-medium text-primary">{props.status?.target ?? t().notConfigured}</span>
            <Show when={props.missing !== "none"}>
              <span class="ml-2 text-amber-600 dark:text-amber-300">{t().missing}: {props.missing}</span>
            </Show>
          </NoticeCard>
        </div>
      </Show>
    </>
  );
}

function SnapshotLogsSection(props: { entries: LogTableEntry[]; loading: boolean; error: string | null }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  return (
    <Show
      when={!props.error}
      fallback={
        <NoticeCard tone="danger" icon={false} bodyClass="flex items-start gap-2">
          <i class="ti ti-alert-circle mt-0.5 shrink-0" />
          <span>{props.error}</span>
        </NoticeCard>
      }
    >
      <LogEntriesTable entries={props.entries} emptyMessage={props.loading ? t().loadingSnapshotLogs : t().noSnapshotLogs} />
    </Show>
  );
}

export function ExportSection(props: { notebook: Notebook; onDirtyChange: (dirty: boolean) => void }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const href = () => `/api/notebooks/${encodeURIComponent(props.notebook.id)}/export.zip`;
  const [lastRun, setLastRun] = createSignal<BackupRunResult | null>(null);
  const [base, setBase] = createSignal({
    enabled: false,
    endpoint: "",
    region: "us-east-1",
    bucket: "",
  });
  const [enabled, setEnabled] = createSignal(false);
  const [endpoint, setEndpoint] = createSignal("");
  const [region, setRegion] = createSignal("us-east-1");
  const [bucket, setBucket] = createSignal("");
  const [accessKeyId, setAccessKeyId] = createSignal("");
  const [secretAccessKey, setSecretAccessKey] = createSignal("");
  const status = query.create({
    source: () => props.notebook.id,
    load: async (notebookId, { abortSignal }): Promise<BackupStatus> => {
      const res = await apiClient[":id"].snapshots.config.$get({ param: { id: notebookId } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().snapshotSettingsLoadFailed));
      return await res.json();
    },
  });
  const logs = query.create({
    source: () => props.notebook.id,
    load: async (notebookId, { abortSignal }): Promise<LogTableEntry[]> => {
      const res = await apiClient[":id"].snapshots.logs.$get(
        {
          param: { id: notebookId },
          query: { _: String(Date.now()) },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().snapshotLogsLoadFailed));
      return await res.json();
    },
  });
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const [reconcileScope, setReconcileScope] = createSignal<boolean | null>(null);
  const [reconciling, setReconciling] = createSignal(false);

  const applyStatus = (current: BackupStatus) => {
    const nextBase = backupDraftFromStatus(current);
    setBase(nextBase);
    setEnabled(nextBase.enabled);
    setEndpoint(nextBase.endpoint);
    setRegion(nextBase.region);
    setBucket(nextBase.bucket);
    setAccessKeyId("");
    setSecretAccessKey("");
  };
  createEffect(() => {
    const current = status.data();
    if (current) applyStatus(current);
  });

  const reconcile = async (includeStatus = true) => {
    setReconcileError(null);
    setReconciling(true);
    try {
      await Promise.all(includeStatus ? [status.invalidate(), logs.invalidate()] : [logs.invalidate()]);
      setReconcileScope(null);
    } catch {
      setReconcileScope(includeStatus);
      setReconcileError(t().snapshotReconcileFailed);
    } finally {
      setReconciling(false);
    }
  };

  type ConfigIntent = {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  const configMutation = mutations.create<BackupStatus, ConfigIntent>({
    mutation: async (intent, { abortSignal }) => {
      const res = await apiClient[":id"].snapshots.config.$put(
        {
          param: { id: props.notebook.id },
          json: intent,
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().snapshotUpdateFailed));
      return await res.json();
    },
    onSuccess: (saved) => {
      applyStatus(saved);
      void reconcile(true);
    },
    onError: (error) => prompts.error(error.message),
  });

  const backupMutation = mutations.create<BackupRunResult, void>({
    mutation: async (_value, { abortSignal }) => {
      const res = await apiClient[":id"].snapshots.run.$post({ param: { id: props.notebook.id } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().snapshotUploadFailed));
      return await res.json();
    },
    onSuccess: (result) => {
      setLastRun(result);
      void reconcile(false);
    },
    onError: (error) => {
      void prompts.error(error.message).finally(() => {
        void logs.refresh();
      });
    },
  });

  const missing = () => status.data()?.missing.join(", ") || "none";
  const dirty = () =>
    backupDraftIsDirty(
      { enabled: enabled(), endpoint: endpoint(), region: region(), bucket: bucket() },
      base(),
      accessKeyId(),
      secretAccessKey(),
    );
  createEffect(() => props.onDirtyChange(dirty()));
  onCleanup(() => {
    configMutation.abort();
    backupMutation.abort();
    props.onDirtyChange(false);
  });

  const discard = () => {
    const current = base();
    setEnabled(current.enabled);
    setEndpoint(current.endpoint);
    setRegion(current.region);
    setBucket(current.bucket);
    setAccessKeyId("");
    setSecretAccessKey("");
  };
  const localLogEntries = (): LogTableEntry[] => {
    const run = lastRun();
    if (!run) return [];
    return [snapshotLogEntryFromRun(run, props.notebook.id)];
  };
  const logEntries = () => {
    const remote = logs.data() ?? [];
    const local = localLogEntries();
    if (local.length === 0) return remote;
    const localSha = String(local[0]?.metadata?.sha256 ?? "");
    return remote.some((entry) => String(entry.metadata?.sha256 ?? "") === localSha) ? remote : [...local, ...remote];
  };
  const logError = () => logs.error()?.message ?? null;

  return (
    <>
      <SettingsGroup title={t().portableExport} description={t().portableExportDescription}>
        <SettingsGroup.Action>
          <ButtonLink href={href()} download="" class="self-start">
            <i class="ti ti-download" />
            {t().downloadZip}
          </ButtonLink>
        </SettingsGroup.Action>
        <NoticeCard tone="info" icon={false}>
          {t().exportIncludes}
        </NoticeCard>
      </SettingsGroup>

      <SettingsGroup title={t().automaticSnapshots} description={t().automaticSnapshotsDescription}>
        <SettingsGroup.Action>
          <SnapshotUploadAction
            enabled={enabled()}
            configured={!!status.data()?.configured}
            loading={backupMutation.loading()}
            disabled={status.loading() || backupMutation.loading() || reconciling()}
            lastRun={lastRun()}
            onRun={() => backupMutation.mutate(undefined)}
          />
        </SettingsGroup.Action>
        <Show when={!status.loading()} fallback={<Placeholder state="loading" variant="panel" title={t().loadingSnapshotSettings} />}>
          <Show
            when={status.data()}
            fallback={
              <Placeholder
                state="error"
                variant="panel"
                title={t().couldNotLoadSnapshotSettings}
                description={status.error()?.message ?? t().snapshotSettingsCouldNotLoad}
                action={
                  <Button type="button" variant="secondary" size="sm" onClick={() => void status.refresh()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {t().retry}
                  </Button>
                }
              />
            }
          >
            <SnapshotConfigFields
              notebookShortId={props.notebook.id}
              enabled={enabled}
              setEnabled={setEnabled}
              endpoint={endpoint}
              setEndpoint={setEndpoint}
              region={region}
              setRegion={setRegion}
              bucket={bucket}
              setBucket={setBucket}
              accessKeyId={accessKeyId}
              setAccessKeyId={setAccessKeyId}
              secretAccessKey={secretAccessKey}
              setSecretAccessKey={setSecretAccessKey}
              status={status.data() ?? undefined}
              missing={missing()}
              saving={configMutation.loading() || reconciling()}
            />
          </Show>
        </Show>
      </SettingsGroup>

      <SettingsGroup title={t().recentSnapshots} description={t().recentSnapshotsDescription}>
        <SnapshotLogsSection entries={logEntries()} loading={logs.loading()} error={logError()} />
        <Show when={reconcileError()}>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <NoticeCard tone="warning" icon={false} class="flex-1">
              {reconcileError()}
            </NoticeCard>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={reconciling()}
              onClick={() => void reconcile(reconcileScope() ?? true)}
            >
              {t().retryReload}
            </Button>
          </div>
        </Show>
      </SettingsGroup>

      <SettingsModal.Footer>
        <SettingsPanelFooter
          changeCount={() => (dirty() ? 1 : 0)}
          loading={() => configMutation.loading() || reconciling()}
          onDiscard={discard}
          onSave={() =>
            configMutation.mutate({
              enabled: enabled(),
              endpoint: endpoint().trim(),
              region: region().trim() || "us-east-1",
              bucket: bucket().trim(),
              accessKeyId: accessKeyId().trim() || undefined,
              secretAccessKey: secretAccessKey().trim() || undefined,
            })
          }
        />
      </SettingsModal.Footer>
    </>
  );
}
