export type SyncNatsPath = "/admin/observability/nats" | "/admin/observability/sync";

/** Changing the scope invalidates the selected detail and both pagination cursors. */
export const syncNatsFilterHref = (path: SyncNatsPath, search: string, updates: Record<string, string | null> = {}) => {
  const params = new URLSearchParams(search);
  for (const key of ["offset", "consumerOffset", "cursor", "stream", "storeApp", "store", "kind", "message", "sequence"])
    params.delete(key);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  return `${path}${params.size ? `?${params}` : ""}`;
};
