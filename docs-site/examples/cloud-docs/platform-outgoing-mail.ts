import { defineApp } from "@k2b/cloud";
import type { MailProfile, PlatformPermission } from "@k2b/cloud/contracts";
import { mail } from "@k2b/cloud/services";

const permissions: readonly PlatformPermission[] = ["mail:send"];
export const outgoingMailApp = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Inventory",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory"],
  platformPermissions: permissions,
});
/** Call after outgoingMailApp.start() completes. */
export const availableSenders = async (): Promise<MailProfile[]> => {
  const result = await mail.profiles();
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};
