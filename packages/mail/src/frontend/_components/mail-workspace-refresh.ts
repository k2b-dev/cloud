export type MailWorkspaceRefreshResult = "applied" | "failed" | "stale";

export const requireMailWorkspaceRefresh = async (refresh: () => Promise<MailWorkspaceRefreshResult>, message: string): Promise<void> => {
  if ((await refresh()) === "failed") throw new Error(message);
};

export const captureMailWorkspaceRefreshError = async (refresh: () => Promise<void>): Promise<Error | null> => {
  try {
    await refresh();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

/**
 * Reports a failed refresh and still rejects, for callers that mark the failure
 * in place themselves, such as the list's pull to refresh.
 */
export const reportMailWorkspaceRefresh = async (refresh: () => Promise<void>, report: (message: string) => void): Promise<void> => {
  const error = await captureMailWorkspaceRefreshError(refresh);
  if (!error) return;
  report(error.message);
  throw error;
};
