import { dialogCore, toast } from "@k2b/ui";
import { workspaceMessages } from "./messages";

const DEFAULT_RELOAD_DELAY_MS = 200;

type DeferredReloadEnvironment = {
  isDialogOpen: () => boolean;
  notifyPending: () => { dismiss: () => void };
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  addCloseListener: (listener: EventListener) => void;
  removeCloseListener: (listener: EventListener) => void;
};

const browserEnvironment: DeferredReloadEnvironment = {
  isDialogOpen: dialogCore.isOpen,
  notifyPending: () => {
    const { t } = workspaceMessages.resolve([document.documentElement.lang]);
    return toast(t.pageRefreshAfterDialog, {
      title: t.workspaceUpdated,
      duration: 0,
      iconClass: "ti ti-refresh",
    });
  },
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  addCloseListener: (listener) => document.addEventListener("close", listener, true),
  removeCloseListener: (listener) => document.removeEventListener("close", listener, true),
};

export const createDeferredWorkspaceReload = (
  reload: () => void,
  delayMs = DEFAULT_RELOAD_DELAY_MS,
  environment: DeferredReloadEnvironment = browserEnvironment,
) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closeFrame: number | null = null;
  let pending = false;
  let disposed = false;
  let pendingToast: { dismiss: () => void } | null = null;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const performReload = () => {
    if (disposed) return;
    clearTimer();
    pending = false;
    pendingToast?.dismiss();
    pendingToast = null;
    reload();
  };

  const flush = () => {
    if (disposed) return;
    clearTimer();
    if (environment.isDialogOpen()) {
      pending = true;
      pendingToast ??= environment.notifyPending();
      return;
    }
    performReload();
  };

  const schedule = () => {
    if (disposed) return;
    clearTimer();
    if (environment.isDialogOpen()) return flush();
    timer = setTimeout(flush, delayMs);
  };

  const onDialogClose = () => {
    if (!pending || disposed) return;
    if (closeFrame !== null) environment.cancelFrame(closeFrame);
    closeFrame = environment.requestFrame(() => {
      closeFrame = null;
      schedule();
    });
  };
  environment.addCloseListener(onDialogClose);

  return {
    schedule,
    reloadNow: performReload,
    dispose: () => {
      disposed = true;
      clearTimer();
      if (closeFrame !== null) environment.cancelFrame(closeFrame);
      closeFrame = null;
      pendingToast?.dismiss();
      pendingToast = null;
      environment.removeCloseListener(onDialogClose);
    },
  };
};
