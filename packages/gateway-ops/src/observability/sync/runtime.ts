import { listApps } from "@valentinkolb/cloud";
import { createSyncOpsService } from "./service";

/** Process-wide service bound to the live app registry. */
export const syncOpsService = createSyncOpsService({ listApps });
