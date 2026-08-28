import { type DateContext, dates, text } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  type DataTableColumn,
  IconButton,
  InlineGuidance,
  NoticeCard,
  Placeholder,
  ProgressBar,
  prompts,
  StatusBadge,
  type StatusTone,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type {
  Mailbox,
  MailboxOperationalHealth,
  MailboxOperatorOperations,
  OperatorActionEligibility,
  ProviderBinding,
  ProviderConnection,
  RedactedOperatorCommand,
} from "../../contracts";
import { PROVIDER_LIMIT_MAX_AGE_MS } from "../../contracts";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

type Messages = ReturnType<typeof mailSettingsMessages.resolve>["t"];

const healthTone = (health: Mailbox["health"]): StatusTone => (health === "active" ? "ok" : health === "paused" ? "neutral" : "warning");

const providerLimitCheckedLabel = (checkedAt: string, dateConfig: DateContext, messages: Messages): string =>
  Date.parse(checkedAt) <= 0
    ? messages.notCheckedYet
    : Date.now() - Date.parse(checkedAt) > PROVIDER_LIMIT_MAX_AGE_MS
      ? messages.limitsOutdated({ checked: dates.formatDateTimeRelative(checkedAt, dateConfig) })
      : messages.limitsChecked({ checked: dates.formatDateTimeRelative(checkedAt, dateConfig) });

const actionLabel = (kind: OperatorActionEligibility["kind"], messages: Messages): string =>
  ({
    sync_mailbox: messages.syncMailbox,
    sync_folder: messages.syncFolder,
    discover_folders: messages.rediscoverFolders,
    verify_binding: messages.verifyConnection,
    rebuild_folder: messages.rebuildFolder,
    hydrate_missing: messages.hydrateMissingBodies,
    rebuild_search: messages.rebuildSearch,
    rebuild_threads: messages.repairThreadProjection,
    reconcile_effect: messages.reconcileEffect,
    retry_command: messages.retryWork,
    cancel_command: messages.cancelWork,
  })[kind];

const activityLabel = (kind: RedactedOperatorCommand["kind"], messages: Messages): string =>
  ({
    sync_mailbox: messages.mailboxSynchronization,
    sync_folder: messages.folderSynchronization,
    discover_folders: messages.folderDiscovery,
    verify_binding: messages.connectionVerification,
    rebuild_folder: messages.folderRebuild,
    hydrate_missing: messages.messageHydrationRepair,
    rebuild_search: messages.searchIndexRebuild,
    rebuild_threads: messages.conversationRepair,
    reconcile_effect: messages.providerReconciliation,
    retry_command: messages.maintenanceRetry,
    cancel_command: messages.maintenanceCancellation,
    set_flags: messages.messageFlagUpdate,
    change_message_state: messages.messageStateUpdate,
    move: messages.messageMove,
    copy: messages.messageCopy,
    delete: messages.messageDeletion,
    create_folder: messages.folderCreation,
    rename_folder: messages.folderRename,
    delete_folder: messages.folderDeletion,
    set_folder_subscription: messages.folderSubscription,
    send: messages.messageDelivery,
  })[kind];

const activityState = (state: RedactedOperatorCommand["state"], messages: Messages): { label: string; icon: string; tone: StatusTone } => {
  if (state === "confirmed" || state === "reconciled") {
    return { label: messages.completed, icon: "ti-circle-check", tone: "ok" };
  }
  if (state === "failed") {
    return { label: messages.failed, icon: "ti-alert-circle", tone: "error" };
  }
  if (state === "ambiguous" || state === "needs_attention") {
    return { label: messages.needsReview, icon: "ti-alert-triangle", tone: "warning" };
  }
  if (state === "executing") {
    return { label: messages.inProgress, icon: "ti-loader-2 animate-spin", tone: "running" };
  }
  if (state === "queued") {
    return { label: messages.queued, icon: "ti-clock", tone: "neutral" };
  }
  return { label: messages.cancelled, icon: "ti-circle-minus", tone: "neutral" };
};

const recentActivityColumns = (messages: Messages): DataTableColumn<RedactedOperatorCommand>[] => [
  { id: "activity", header: messages.activity, value: (row) => activityLabel(row.kind, messages) },
  {
    id: "detail",
    header: messages.details,
    value: (row) =>
      row.errorCode ? messages.errorCode({ code: row.errorCode }) : row.attempt > 1 ? messages.attempt({ attempt: row.attempt }) : "",
  },
  { id: "updatedAt", header: messages.updated, value: "updatedAt", class: "w-36" },
];

export default function MailOperationalSettings(props: {
  mailbox: Mailbox;
  health: MailboxOperationalHealth;
  bindings: ProviderBinding[];
  connections: ProviderConnection[];
  dateConfig: DateContext;
  reloading: boolean;
  onReload: () => Promise<void>;
  onWorkspaceChange: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  let disposed = false;
  const [refreshingConnectionId, setRefreshingConnectionId] = createSignal<string | null>(null);
  type OperationalCommand =
    | { kind: "sync_mailbox" }
    | { kind: "discover_folders"; bindingId?: string }
    | { kind: "verify_binding"; bindingId: string };
  const [lastCommand, setLastCommand] = createSignal<OperationalCommand["kind"]>("sync_mailbox");
  const [reconciling, setReconciling] = createSignal(false);
  const reconcileAfterWrite = (work: () => Promise<void>, title: string) => {
    setReconciling(true);
    void work()
      .catch((error) => prompts.error(error instanceof Error ? error.message : messages().mailboxStateRefreshFailed, { title }))
      .finally(() => setReconciling(false));
  };
  const operatorOperations = query.createInfinite<string, MailboxOperatorOperations, string>({
    source: () => props.mailbox.id,
    loadPage: async (mailboxId, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].operations.$get(
        { param: { mailboxId }, query: { attentionCursor: cursor, attentionLimit: "100" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadOperatorStatus));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextAttentionCursor, "mailbox operations");
      return page;
    },
    getNextCursor: (page) => page.nextAttentionCursor,
  });
  const operatorStatus = createMemo(() => {
    const [first, ...rest] = operatorOperations.pages();
    if (!first) return undefined;
    const attention = new Map(first.attentionCommands.map((item) => [item.id, item]));
    for (const page of rest) for (const item of page.attentionCommands) attention.set(item.id, item);
    return {
      ...first,
      attentionCommands: [...attention.values()],
      nextAttentionCursor: rest.at(-1)?.nextAttentionCursor ?? first.nextAttentionCursor,
    };
  });
  const updateSync = mutations.create<Mailbox, boolean>({
    mutation: async (syncEnabled, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].$patch(
        {
          param: { mailboxId: props.mailbox.id },
          json: { syncEnabled },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok)
        throw new Error(await readApiError(response, syncEnabled ? messages().failedResumeMailbox : messages().failedPauseMailbox));
      return response.json();
    },
    onSuccess: (mailbox) => {
      toast.success(mailbox.syncEnabled ? messages().mailboxResumed : messages().mailboxPaused);
      props.onWorkspaceChange();
      reconcileAfterWrite(props.onReload, messages().mailboxUpdatedRefreshFailed);
    },
    onError: (error) => prompts.error(error.message),
  });

  const command = mutations.create<void, OperationalCommand, { idempotencyKey: string }>({
    onBefore: (input) => {
      setLastCommand(input.kind);
      return { idempotencyKey: crypto.randomUUID() };
    },
    mutation: async (input, { abortSignal, idempotencyKey }) => {
      const response = await apiClient.mailboxes[":mailboxId"].commands.$post(
        {
          param: { mailboxId: props.mailbox.id },
          json: { ...input, idempotencyKey },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedStartMaintenance));
    },
    onSuccess: () => {
      toast.success(
        lastCommand() === "sync_mailbox"
          ? messages().mailboxSyncStarted
          : lastCommand() === "verify_binding"
            ? messages().providerVerificationStarted
            : messages().folderDiscoveryStarted,
      );
      props.onWorkspaceChange();
      reconcileAfterWrite(async () => {
        await operatorOperations.refresh();
        await props.onReload();
      }, messages().commandQueuedRefreshFailed);
    },
    onError: (error) => prompts.error(error.message),
  });
  const refreshLimits = mutations.create<ProviderConnection, string>({
    mutation: async (connectionId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].connections[":connectionId"].limits.refresh.$post(
        {
          param: { mailboxId: props.mailbox.id, connectionId },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, messages().failedRefreshProviderLimits));
      }
      return response.json();
    },
    onSuccess: () => {
      toast.success(messages().providerLimitsRefreshed);
      setRefreshingConnectionId(null);
      reconcileAfterWrite(props.onReload, messages().limitsRefreshedMailboxRefreshFailed);
    },
    onError: (error) => {
      setRefreshingConnectionId(null);
      prompts.error(error.message);
    },
  });
  const operatorCommand = mutations.create<void, OperatorActionEligibility, { idempotencyKey: string }>({
    onBefore: () => ({ idempotencyKey: crypto.randomUUID() }),
    mutation: async (action, { abortSignal, idempotencyKey }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["operator-actions"].$post(
        {
          param: { mailboxId: props.mailbox.id },
          json: { kind: action.kind, ...action.target, idempotencyKey } as never,
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedQueueOperatorAction));
    },
    onSuccess: () => {
      toast.success(messages().operatorActionQueued);
      props.onWorkspaceChange();
      reconcileAfterWrite(operatorOperations.refresh, messages().operatorActionQueuedRefreshFailed);
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    disposed = true;
    updateSync.abort();
    command.abort();
    refreshLimits.abort();
    operatorCommand.abort();
  });

  const pause = async () => {
    const confirmed = await prompts.confirm(messages().pauseMailboxDescription, {
      title: messages().pauseMailboxQuestion,
      confirmText: messages().pauseMailbox,
    });
    if (!disposed && confirmed) updateSync.mutate(false);
  };

  const busy = () =>
    props.reloading || reconciling() || updateSync.loading() || command.loading() || operatorCommand.loading() || refreshLimits.loading();
  const syncLoading = () => command.loading() && lastCommand() === "sync_mailbox";

  const connectedBinding = () =>
    props.bindings.find((binding) => binding.state === "active") ?? props.bindings.find((binding) => binding.state !== "revoked");
  const discoveryNeedsAttention = () => props.health.discovery.missingFolders + props.health.discovery.ambiguousFolders;
  const stateLabel = (state: string) => {
    if (state === "active") return messages().statusActive;
    if (state === "degraded") return messages().statusDegraded;
    if (state === "revoked") return messages().statusRevoked;
    if (state === "pending") return messages().statusPending;
    if (state === "verifying") return messages().statusVerifying;
    if (state === "missing") return messages().stateMissing;
    if (state === "ambiguous") return messages().stateAmbiguous;
    if (state === "current") return messages().stateCurrent;
    if (state === "syncing") return messages().stateSyncing;
    if (state === "rebuilding") return messages().stateRebuilding;
    if (state === "failed") return messages().failed;
    return state;
  };
  const healthMessage = () => {
    const health = props.health.health;
    if (health === "active") return messages().providerOperational;
    if (health === "paused") return messages().healthPausedMessage;
    if (health === "auth_required") return messages().healthAuthMessage;
    if (health === "connection_required") return messages().healthConnectionRequiredMessage;
    if (health === "disconnected") return messages().healthDisconnectedMessage;
    if (health === "verifying") return messages().healthVerifyingMessage;
    if (health === "bootstrapping") return messages().healthBootstrappingMessage;
    if (health === "reconnecting") return messages().healthReconnectingMessage;
    return messages().healthDegradedMessage;
  };
  const healthSummary = createMemo(() => {
    const reviewCount = props.health.discovery.missingFolders + props.health.discovery.ambiguousFolders;
    const degradedFolders = props.health.sync.folderStates.degraded ?? 0;
    const currentFolders = props.health.sync.folderStates.current ?? 0;
    const rebuildingFolders = props.health.sync.folderStates.rebuilding ?? 0;
    const syncingFolders = props.health.sync.folderStates.syncing ?? 0;
    const pendingFolders = props.health.sync.folderStates.pending ?? 0;
    const accounts =
      props.health.bindings.degraded > 0
        ? `${props.health.bindings.active > 0 ? `${messages().connectedAccountCount({ count: props.health.bindings.active })} · ` : ""}${messages().degradedAccountCount({ count: props.health.bindings.degraded })}`
        : props.health.bindings.active > 0
          ? messages().connectedAccountCount({ count: props.health.bindings.active })
          : props.health.bindings.pending > 0
            ? messages().pendingAccountCount({ count: props.health.bindings.pending })
            : messages().noConnectedAccount;
    const discovery = `${messages().discoveredFolderCount({ count: props.health.discovery.activeFolders })}${reviewCount > 0 ? ` · ${messages().needsReviewCount({ count: reviewCount })}` : ""}`;
    const synchronization =
      props.health.sync.runningRuns > 0
        ? messages().runningSyncCount({ count: props.health.sync.runningRuns })
        : degradedFolders > 0
          ? `${messages().degradedFolderCount({ count: degradedFolders })}${currentFolders > 0 ? ` · ${messages().currentFolderCount({ count: currentFolders })}` : ""}`
          : rebuildingFolders > 0
            ? messages().rebuildingFolderCount({ count: rebuildingFolders })
            : syncingFolders > 0
              ? messages().syncingFolderCount({ count: syncingFolders })
              : currentFolders > 0
                ? messages().currentFolderCount({ count: currentFolders })
                : pendingFolders > 0
                  ? messages().pendingFolderCount({ count: pendingFolders })
                  : messages().noSynchronizedFolders;
    return {
      accounts,
      discovery,
      synchronization,
      search: props.health.search.bm25Ready ? messages().searchAdvanced : messages().searchStandard,
    };
  });

  return (
    <div class="flex flex-col gap-5">
      <section class="flex flex-wrap items-start gap-4 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-4">
        <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center app-accent-text">
          <i class={`ti ${props.health.health === "active" ? "ti-heartbeat" : "ti-alert-circle"}`} aria-hidden="true" />
        </span>
        <div class="min-w-64 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-base font-semibold text-primary">{messages().mailboxStatus}</h3>
            <StatusBadge
              tone={healthTone(props.health.health)}
              label={
                props.health.health === "active"
                  ? messages().statusActive
                  : props.health.health === "paused"
                    ? messages().mailboxPaused
                    : messages().needsReview
              }
            />
          </div>
          <p class="mt-1 text-sm text-secondary">{healthMessage()}</p>
          <p class="mt-2 text-xs text-dimmed">
            {connectedBinding()?.authenticatedPrincipal || messages().noConnectedAccount}
            {" · "}
            <Show when={props.health.sync.lastAt} fallback={messages().noSuccessfulSync}>
              {(lastAt) => (
                <time datetime={lastAt()} title={dates.formatDateTime(lastAt(), props.dateConfig)}>
                  {messages().lastSuccessfulSync({ date: dates.formatDateTimeRelative(lastAt(), props.dateConfig) })}
                </time>
              )}
            </Show>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            type="button"
            disabled={busy() || !props.mailbox.syncEnabled}
            aria-busy={syncLoading()}
            onClick={() => command.mutate({ kind: "sync_mailbox" })}
          >
            <i class={`ti ${syncLoading() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} aria-hidden="true" />
            {messages().syncNow}
          </Button>
          <Show
            when={props.mailbox.syncEnabled}
            fallback={
              <Button variant="secondary" size="sm" type="button" disabled={busy()} onClick={() => updateSync.mutate(true)}>
                <i class="ti ti-player-play" aria-hidden="true" /> {messages().resumeMailbox}
              </Button>
            }
          >
            <Button variant="secondary" size="sm" type="button" disabled={busy()} onClick={() => void pause()}>
              <i class="ti ti-player-pause" aria-hidden="true" /> {messages().pauseMailbox}
            </Button>
          </Show>
        </div>
      </section>

      <div class="flex flex-wrap gap-x-5 gap-y-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-3 py-2.5 text-xs text-secondary">
        <span class="flex items-center gap-1.5">
          <i class="ti ti-server app-accent-text" aria-hidden="true" />
          {healthSummary().accounts}
        </span>
        <span class="flex items-center gap-1.5">
          <i class={`ti ${discoveryNeedsAttention() > 0 ? "ti-alert-triangle" : "ti-folders"} app-accent-text`} aria-hidden="true" />
          {healthSummary().discovery}
        </span>
        <span class="flex items-center gap-1.5">
          <i class="ti ti-refresh app-accent-text" aria-hidden="true" />
          {healthSummary().synchronization}
        </span>
        <span class="flex items-center gap-1.5">
          <i class="ti ti-search app-accent-text" aria-hidden="true" />
          {healthSummary().search}
        </span>
      </div>

      <section class="flex flex-col gap-3">
        <div>
          <h3 class="text-sm font-semibold text-primary">{messages().providerLimits}</h3>
          <p class="mt-1 text-xs text-dimmed">{messages().providerLimitsDescription}</p>
        </div>
        <Show
          when={props.connections.some((connection) => connection.status !== "revoked")}
          fallback={<p class="text-xs text-secondary">{messages().connectProviderForLimits}</p>}
        >
          <div class="flex flex-col gap-2">
            <For each={props.connections.filter((connection) => connection.status !== "revoked")}>
              {(connection) => {
                const storage = () => connection.limits.imap.storage;
                const storagePercent = () => {
                  const value = storage();
                  if (!value) return 0;
                  if (value.limit === 0) return value.used === 0 ? 0 : 100;
                  return Math.min(100, (value.used / value.limit) * 100);
                };
                return (
                  <div class="flex flex-col gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2.5">
                    <div class="flex min-w-0 items-center gap-3">
                      <i class="ti ti-server shrink-0 text-secondary" aria-hidden="true" />
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium text-primary">{connection.name}</p>
                        <p class="truncate text-xs text-dimmed">{connection.email}</p>
                      </div>
                      <span class="shrink-0 text-xs text-dimmed">
                        {providerLimitCheckedLabel(connection.limits.checkedAt, props.dateConfig, messages())}
                      </span>
                      <IconButton
                        type="button"
                        size="sm"
                        title={messages().refreshProviderLimits}
                        label={messages().refreshLimitsFor({ name: connection.name })}
                        disabled={busy()}
                        onClick={() => {
                          setRefreshingConnectionId(connection.id);
                          refreshLimits.mutate(connection.id);
                        }}
                      >
                        <i
                          class={`ti ${refreshingConnectionId() === connection.id ? "ti-loader-2 animate-spin" : "ti-refresh"}`}
                          aria-hidden="true"
                        />
                      </IconButton>
                    </div>
                    <Show
                      when={storage()}
                      fallback={
                        <p class="text-xs text-secondary">
                          {connection.limits.imap.status === "unsupported"
                            ? messages().imapLimitsUnsupported
                            : connection.limits.imap.status === "supported"
                              ? messages().noStorageQuotaReported
                              : messages().storageUsageUnavailable}
                        </p>
                      }
                    >
                      {(quota) => (
                        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
                          <ProgressBar
                            value={storagePercent()}
                            size="xs"
                            tone={storagePercent() >= 90 ? "danger" : "info"}
                            label={messages().mailboxStorageLabel({ name: connection.name })}
                          />
                          <span class="text-xs tabular-nums text-secondary">
                            {messages().usedOfLimit({
                              used: text.pprintBytes(quota().used, { locale: locale() }),
                              limit: text.pprintBytes(quota().limit, { locale: locale() }),
                            })}
                          </span>
                        </div>
                      )}
                    </Show>
                    <Show when={connection.limits.imap.messages}>
                      {(quota) => (
                        <p class="text-xs tabular-nums text-secondary">
                          {messages().messageQuota({ used: quota().used, limit: quota().limit })}
                        </p>
                      )}
                    </Show>
                    <p class="text-xs text-secondary">
                      {connection.limits.smtp.maxMessageBytes
                        ? messages().maxOutgoingMessage({
                            size: text.pprintBytes(connection.limits.smtp.maxMessageBytes, { locale: locale() }),
                          })
                        : connection.limits.smtp.status === "unsupported"
                          ? messages().smtpLimitUnsupported
                          : connection.limits.smtp.status === "supported"
                            ? messages().noSmtpMaximumReported
                            : messages().outgoingLimitUnavailable}
                    </p>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </section>

      <Show when={operatorOperations.loading() && !operatorStatus()}>
        <Placeholder state="loading" variant="panel" title={messages().loadingMailboxActivity} />
      </Show>
      <Show when={operatorOperations.error()}>
        <Placeholder
          state="error"
          variant="panel"
          title={messages().couldNotLoadMailboxActivity}
          description={operatorOperations.error()?.message ?? messages().tryLoadMailboxStatusAgain}
          action={
            <Button variant="secondary" size="sm" type="button" onClick={() => void operatorOperations.refresh()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {messages().retry}
            </Button>
          }
        />
      </Show>
      <Show when={operatorStatus()}>
        {(status) => (
          <section class="flex flex-col gap-3">
            <div>
              <h3 class="text-sm font-semibold text-primary">{messages().recentActivity}</h3>
              <p class="mt-1 text-xs text-dimmed">{messages().recentActivityDescription}</p>
            </div>
            <DataTable
              rows={status().recentCommands}
              columns={recentActivityColumns(messages())}
              getRowId={(row) => row.id}
              density="compact"
              surface="paper"
              stickyHeader={false}
              ariaLabel={messages().recentMailboxActivity}
              empty={
                status().sync.lastAt ? (
                  <span class="inline-flex items-center gap-2">
                    <i class="ti ti-circle-check" aria-hidden="true" />
                    {messages().mailboxSynchronized}
                    <time class="text-dimmed" datetime={status().sync.lastAt!}>
                      {dates.formatDateTimeRelative(status().sync.lastAt!, props.dateConfig)}
                    </time>
                  </span>
                ) : (
                  messages().noMaintenanceActivity
                )
              }
              renderCell={({ row, col, render }) => {
                if (col.id === "activity") {
                  const state = activityState(row.state, messages());
                  const completed = row.state === "confirmed" || row.state === "reconciled";
                  return (
                    <span class="flex min-w-0 items-center gap-2">
                      <i class={`ti ${state.icon} shrink-0`} aria-hidden="true" />
                      <span class="truncate font-medium text-primary">{activityLabel(row.kind, messages())}</span>
                      <Show when={!completed}>
                        <StatusBadge tone={state.tone} label={state.label} />
                      </Show>
                    </span>
                  );
                }
                if (col.id === "detail") {
                  const detail = row.errorCode
                    ? messages().errorCode({ code: row.errorCode })
                    : row.attempt > 1
                      ? messages().attempt({ attempt: row.attempt })
                      : null;
                  return detail ? <span class="text-secondary">{detail}</span> : <span class="text-dimmed">—</span>;
                }
                if (col.id === "updatedAt") {
                  return (
                    <time class="whitespace-nowrap text-dimmed" datetime={row.updatedAt}>
                      {dates.formatDateTimeRelative(row.updatedAt, props.dateConfig)}
                    </time>
                  );
                }
                return render(row.updatedAt);
              }}
            />
          </section>
        )}
      </Show>

      <details class="group rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)]">
        <summary class="focus-ui flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5 text-sm font-medium text-primary">
          <span class="flex items-center gap-2">
            <i class="ti ti-tool" aria-hidden="true" />
            {messages().advancedDiagnostics}
          </span>
          <i class="ti ti-chevron-down transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <section class="flex flex-col gap-5 px-3 pb-3">
          <Show when={operatorStatus()}>
            {(status) => (
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="text-xs font-semibold text-primary">{messages().repairCoverage}</p>
                  <p class="mt-1 text-xs text-dimmed">
                    {messages().coverageSummary({
                      hydration: `${status().coverage.hydration.covered}/${status().coverage.hydration.total}`,
                      search: `${status().coverage.search.covered}/${status().coverage.search.total}`,
                      threads: `${status().coverage.threads.covered}/${status().coverage.threads.total}`,
                    })}
                  </p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <For
                    each={status().actions.filter((action) =>
                      ["hydrate_missing", "rebuild_search", "rebuild_threads"].includes(action.kind),
                    )}
                  >
                    {(action) => (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        disabled={busy() || !action.eligible}
                        title={action.reason ?? actionLabel(action.kind, messages())}
                        onClick={() => operatorCommand.mutate(action)}
                      >
                        <i class="ti ti-tool" aria-hidden="true" /> {actionLabel(action.kind, messages())}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>

          <div class="flex flex-col gap-2">
            <p class="text-xs font-semibold text-primary">{messages().accountsAndIdentities}</p>
            <Show
              when={props.bindings.some((binding) => binding.state !== "revoked")}
              fallback={<InlineGuidance>{messages().noConnectedAccountForDiscovery}</InlineGuidance>}
            >
              <For each={props.bindings.filter((binding) => binding.state !== "revoked")}>
                {(binding) => (
                  <div class="flex flex-wrap items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-3 py-2.5">
                    <i class="ti ti-server text-lg text-dimmed" aria-hidden="true" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium text-primary">
                        {binding.authenticatedPrincipal || messages().remoteMailbox}
                      </span>
                      <span class="block text-xs text-dimmed">
                        {stateLabel(binding.state)}
                        {binding.lastError ? ` · ${binding.lastError}` : ""}
                      </span>
                    </span>
                    <Show
                      when={binding.state === "pending"}
                      fallback={
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          disabled={busy()}
                          onClick={() => command.mutate({ kind: "discover_folders", bindingId: binding.id })}
                        >
                          <i class="ti ti-folders" aria-hidden="true" /> {messages().rediscoverFolders}
                        </Button>
                      }
                    >
                      <Button
                        size="sm"
                        type="button"
                        disabled={busy()}
                        onClick={() => command.mutate({ kind: "verify_binding", bindingId: binding.id })}
                      >
                        <i class="ti ti-shield-check" aria-hidden="true" /> {messages().verifyConnection}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <Show when={operatorStatus()}>
            {(status) => (
              <>
                <Show when={status().folders.length > 0}>
                  <div class="flex flex-col gap-2">
                    <p class="text-xs font-semibold text-primary">{messages().folderMaintenance}</p>
                    <NoticeCard tone="neutral" icon={false} bodyClass="flex items-start gap-2">
                      <i class="ti ti-info-circle mt-0.5 shrink-0" aria-hidden="true" />
                      <p>{messages().folderMaintenanceDescription}</p>
                    </NoticeCard>
                    <For each={status().folders}>
                      {(folder) => (
                        <div class="flex flex-wrap items-center gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-3 py-2">
                          <span class="min-w-0 flex-1 text-xs text-secondary">
                            <span class="block truncate font-medium text-primary">{folder.name}</span>
                            <span>
                              {stateLabel(folder.discoveryState)} · {stateLabel(folder.syncStatus)}
                            </span>
                          </span>
                          <For each={folder.actions}>
                            {(action) => (
                              <Button
                                variant="secondary"
                                size="sm"
                                type="button"
                                disabled={busy() || !action.eligible}
                                title={action.reason ?? actionLabel(action.kind, messages())}
                                onClick={() => operatorCommand.mutate(action)}
                              >
                                <i class="ti ti-tool" aria-hidden="true" /> {actionLabel(action.kind, messages())}
                              </Button>
                            )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>

                <Show when={status().attentionCommands.length > 0}>
                  <div class="flex flex-col gap-2">
                    <p class="text-xs font-semibold text-primary">{messages().needsReview}</p>
                    <For each={status().attentionCommands}>
                      {(item) => {
                        const state = activityState(item.state, messages());
                        return (
                          <div class="flex flex-wrap items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-3 py-2.5">
                            <span class="min-w-64 flex-1">
                              <span class="flex flex-wrap items-center gap-2">
                                <span class="text-sm font-medium text-primary">{activityLabel(item.kind, messages())}</span>
                                <StatusBadge tone={state.tone} label={state.label} />
                              </span>
                              <span class="mt-0.5 block text-xs text-secondary">
                                <time datetime={item.updatedAt} title={dates.formatDateTime(item.updatedAt, props.dateConfig)}>
                                  {messages().updatedAtRelative({ date: dates.formatDateTimeRelative(item.updatedAt, props.dateConfig) })}
                                </time>
                                {item.errorCode ? ` · ${item.errorCode}` : ""}
                              </span>
                              <span class="block truncate text-[11px] text-dimmed" title={item.id}>
                                {messages().commandId({ id: item.id })}
                              </span>
                            </span>
                            <div class="flex flex-wrap gap-2">
                              <For each={item.actions.filter((action) => action.eligible)}>
                                {(action) => (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    type="button"
                                    disabled={busy()}
                                    onClick={() => operatorCommand.mutate(action)}
                                  >
                                    {actionLabel(action.kind, messages())}
                                  </Button>
                                )}
                              </For>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                    <Show when={operatorOperations.hasMore()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        class="self-center"
                        disabled={operatorOperations.loadingMore()}
                        onClick={() => void operatorOperations.loadMore()}
                      >
                        <i
                          class={operatorOperations.loadingMore() ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-down"}
                          aria-hidden="true"
                        />
                        {messages().loadMoreAttentionItems}
                      </Button>
                    </Show>
                  </div>
                </Show>
              </>
            )}
          </Show>
        </section>
      </details>
    </div>
  );
}
