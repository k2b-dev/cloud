import { coreClient } from "../clients/core";
import type { CloudResourceRef } from "../contracts/capabilities";
import { CODE_ACCOUNT_HANDLE_PATTERN } from "../contracts/shared";
import type { FoundServiceAccount } from "./PrincipalPicker";

/** Exact Kennung only. Core checks current Manage on this target and applies the shared lookup budget. */
export const findTargetServiceAccount = async (
  target: CloudResourceRef,
  value: string,
  signal: AbortSignal,
): Promise<FoundServiceAccount | null> => {
  const handle = value.trim();
  if (!CODE_ACCOUNT_HANDLE_PATTERN.test(handle)) return null;
  const response = await coreClient.accounts.entities.$get(
    { query: { search: handle, target_type: target.type, target_id: target.id, kinds: "service_account", service_account_kinds: "code" } },
    { init: { signal } },
  );
  if (!response.ok) throw new Error(response.statusText);
  const found = (await response.json()).items.find(
    (item) => item.kind === "service_account" && item.serviceAccount.kind === "code" && item.serviceAccount.handle === handle,
  );
  if (!found || found.kind !== "service_account") return null;
  return {
    principal: { type: "service_account", serviceAccountId: found.serviceAccount.id },
    display: { displayName: found.serviceAccount.name, serviceAccountKind: "code" },
    description: found.serviceAccount.description,
  };
};
