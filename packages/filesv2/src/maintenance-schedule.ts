import { lazySync } from "@k2b/cloud";
import { homeProvisioning } from "./data/home-provisioning";

export const MAINTENANCE_ID = "filesv2:directory-maintenance";
export const maintenanceScheduler = lazySync((sync) =>
  sync.scheduler({ id: MAINTENANCE_ID, delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [5_000, 15_000] } }),
);
export async function requestHomeReconciliation() {
  await homeProvisioning.request();
  await maintenanceScheduler().runNow({ id: MAINTENANCE_ID, requestId: crypto.randomUUID() });
}
