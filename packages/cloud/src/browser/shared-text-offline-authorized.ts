import { openSharedTextOffline, type SharedTextOfflineIdentity, type SharedTextOfflineSession } from "./shared-text-offline";

/**
 * Capture the device's logout fence BEFORE asking the server to authorize a
 * session. Opening touches epoch metadata only. No draft bytes escape until
 * authorization succeeds and load rechecks the same epoch transactionally.
 */
export const openAuthorizedSharedTextOffline = async <Authorized>(
  identity: SharedTextOfflineIdentity,
  authorize: (signal: AbortSignal) => Promise<Authorized>,
  signal?: AbortSignal,
): Promise<{ session: SharedTextOfflineSession; authorization: Authorized; state: Uint8Array | null; baseCursor: string | null }> => {
  signal?.throwIfAborted();
  const session = await openSharedTextOffline(identity);
  const stop = () => session.close();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    const authorization = await authorize(session.signal);
    session.signal.throwIfAborted();
    const pending = await session.loadPending();
    return { session, authorization, state: pending?.state ?? null, baseCursor: pending?.baseCursor ?? null };
  } catch (error) {
    session.close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
};
