import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import { geoClient } from "@k2b/cloud/server";
import type { NotebookMapState } from "../lib/map-blocks";

/** Availability is resolved under the reading caller, before the authorized HTML snapshot is sent. */
export async function notebookMapState(
  markdown: string,
  caller?: CapabilityCaller,
  canAdmin = false,
): Promise<NotebookMapState | undefined> {
  if (!caller || !/^ {0,3}:::map[ \t]*$/m.test(markdown)) return undefined;
  const result = await geoClient.availability(caller);
  return result.ok ? { availability: result.data.data, canAdmin } : { failed: true, canAdmin };
}
