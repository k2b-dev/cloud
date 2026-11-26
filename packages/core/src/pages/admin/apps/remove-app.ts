/** Hides an app that is not running from the list; Core and every provider that reported it forget its entry. */
export const removeAppListing = async (appId: string, signal?: AbortSignal): Promise<"removed" | "running" | "failed"> => {
  const response = await fetch(`/api/admin/apps/${encodeURIComponent(appId)}/listing`, {
    method: "DELETE",
    credentials: "same-origin",
    signal,
  }).catch(() => null);
  if (response?.ok) return "removed";
  if (response?.status === 409) return "running";
  return "failed";
};
