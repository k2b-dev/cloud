import type { FoundServiceAccount } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";

/** Only A2's exact handle result may become a service-account row; names and UUIDs never do. */
export const findAiServiceAccount = async (
  target: { type: "core.ai.skill" | "core.ai.project"; id: string },
  handle: string,
  signal: AbortSignal,
): Promise<FoundServiceAccount | null> => {
  const response = await coreClient.accounts.entities.$get(
    { query: { search: handle, target_type: target.type, target_id: target.id, kinds: "service_account", service_account_kinds: "code" } },
    { init: { signal } },
  );
  if (!response.ok) {
    const error = await response.json();
    throw new Error("message" in error ? error.message : response.statusText);
  }
  const result = (await response.json()).items.find(
    (item) => item.kind === "service_account" && item.serviceAccount.kind === "code" && item.serviceAccount.handle === handle.trim(),
  );
  if (!result || result.kind !== "service_account") return null;
  return {
    principal: { type: "service_account", serviceAccountId: result.serviceAccount.id },
    display: { displayName: result.serviceAccount.name, serviceAccountKind: result.serviceAccount.kind },
    description: result.serviceAccount.description,
  };
};
