import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import type { User } from "@k2b/cloud/contracts/shared";
import { ok, type Result } from "@k2b/cloud/server";
import { type KnownApp, listKnownApps } from "../../../known-apps";
import { createMaintenanceService, type MaintenanceService } from "../../../maintenance";

export const MAINTENANCE_ADMIN_PATH = "/admin/settings/maintenance";

/**
 * The page's initial state through the same service and permission check as the API. Nothing else is read before
 * that check passes, so a caller without the administrator role learns nothing about the maintenance.
 */
export const loadMaintenanceAdmin = async (
  user: User | undefined,
  {
    service = createMaintenanceService(),
    knownApps = listKnownApps,
  }: { service?: MaintenanceService; knownApps?: () => Promise<KnownApp[]> } = {},
): Promise<Result<{ status: MaintenanceStatus; appNames: Record<string, string> }>> => {
  const status = await service.status(user);
  if (!status.ok) return status;
  // Apps that are still starting are not registered, so their names come from Core's catalogue of known apps.
  const appNames = Object.fromEntries((await knownApps()).map((app) => [app.id, app.name]));
  return ok({ status: status.data, appNames });
};
