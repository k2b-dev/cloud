import type { SyncStateEventDetail } from "../detail/events";

/** How long one connect attempt gets before the panel calls it failed. */
export const CONNECT_SETTLE_MS = 5_000;

/** After connecting, shares the toolbar's disconnect grace; save times require replay confirmation. */
export const createSyncStateBridge = (options: { hasUnsentChanges: () => boolean; emit: (detail: SyncStateEventDetail) => void }) => {
  let connected = false;
  let hasConnected = false;
  let ready = false;
  let reportedConnected = true;
  let lastSavedAt: string | null = null;
  /** The session ended for good (access, storage); the editor's own recovery bar takes over until it reconnects. */
  let ended = false;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  const emit = () => options.emit({ connected: reportedConnected, lastSavedAt, ended });
  const confirmSaved = () => {
    if (connected && ready && !options.hasUnsentChanges()) lastSavedAt = new Date().toISOString();
    emit();
  };
  const connectionChanged = (value: boolean) => {
    connected = value;
    ready = false;
    clearTimeout(offlineTimer);
    if (value) {
      hasConnected = true;
      reportedConnected = true;
      ended = false;
      emit();
    } else {
      offlineTimer = setTimeout(
        () => {
          reportedConnected = false;
          emit();
        },
        hasConnected ? 1_000 : CONNECT_SETTLE_MS,
      );
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
    end: () => {
      ended = true;
      emit();
    },
    dispose: () => clearTimeout(offlineTimer),
  };
};
