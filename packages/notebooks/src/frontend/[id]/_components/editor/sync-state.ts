import type { SyncStateEventDetail } from "../detail/events";

/** Shares the toolbar's one-second disconnect grace; save times require replay confirmation. */
export const createSyncStateBridge = (options: { hasUnsentChanges: () => boolean; emit: (detail: SyncStateEventDetail) => void }) => {
  let connected = false;
  let ready = false;
  let reportedConnected = true;
  let lastSavedAt: string | null = null;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => options.emit({ connected: reportedConnected, lastSavedAt });
  const confirmSaved = () => {
    if (connected && ready && !options.hasUnsentChanges()) lastSavedAt = new Date().toISOString();
    emit();
  };
  const connectionChanged = (value: boolean) => {
    connected = value;
    ready = false;
    clearTimeout(offlineTimer);
    if (value) {
      reportedConnected = true;
      emit();
    } else {
      offlineTimer = setTimeout(() => {
        reportedConnected = false;
        emit();
      }, 1_000);
    }
  };
  connectionChanged(false);
  return {
    connectionChanged,
    ready: () => {
      ready = true;
      confirmSaved();
    },
    unsentChanged: confirmSaved,
    request: emit,
    dispose: () => clearTimeout(offlineTimer),
  };
};
