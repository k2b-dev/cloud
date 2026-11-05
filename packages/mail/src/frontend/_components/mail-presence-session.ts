export const createMailPresenceSession = <TSnapshot>(options: {
  heartbeat: (signal: AbortSignal) => Promise<TSnapshot | null>;
  leave: () => Promise<unknown>;
  onSnapshot: (snapshot: TSnapshot) => void;
  /** A heartbeat failed or timed out; the next interval retries it. */
  onFailure?: () => void;
  requestTimeoutMs?: number;
}) => {
  let controller: AbortController | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const heartbeat = async () => {
    if (disposed || controller) return;
    const current = new AbortController();
    controller = current;
    timeout = setTimeout(() => current.abort(), options.requestTimeoutMs ?? 8_000);
    try {
      const snapshot = await options.heartbeat(current.signal);
      if (disposed) return;
      if (snapshot && !current.signal.aborted) options.onSnapshot(snapshot);
      else options.onFailure?.();
    } catch {
      // Presence is best-effort and the next interval retries it.
      if (!disposed) options.onFailure?.();
    } finally {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (controller === current) controller = null;
    }
  };

  return {
    heartbeat,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      controller?.abort();
      controller = null;
      void options.leave().catch(() => undefined);
    },
  };
};
