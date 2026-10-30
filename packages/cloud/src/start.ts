// Keep this entry independent of the platform barrel and application modules.
import { initializeClients } from "./runtime/clients";
import { bindConnections, hasConnections } from "./runtime/connections";
import { resolveConnections } from "./runtime/resolve-connections";

export type PlatformStartOptions = {
  appId: string;
  /** Core and Gateway always use infrastructure environment values. */
  source?: "env";
};

/** Initialize before importing any application module, also in dev and data workers. */
export const initializePlatform = async ({ appId, source }: PlatformStartOptions): Promise<void> => {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(appId)) throw new Error("Platform start requires a valid appId");
  if (hasConnections()) throw new Error("Platform has already started");
  if (appId === "core" || appId === "gateway") source = "env";
  // Slice 6b seam: validate the app key and fetch missing values from Core here,
  // then pass the typed response to resolveConnections({ appId, core }).
  // A present key must never silently fall back to the legacy env mode.
  if (source !== "env" && (process.env.CLOUD_APP_KEY?.trim() || process.env.CLOUD_APP_KEY_FILE?.trim())) {
    throw new Error("Core connection bootstrap is not available yet");
  }
  const resolved = resolveConnections({ appId });
  bindConnections(resolved);
  try {
    await initializeClients();
  } catch (error) {
    bindConnections(undefined);
    throw error;
  }
};

export const startPlatform = async <T>({ load, ...options }: PlatformStartOptions & { load: () => Promise<T> }): Promise<T> => {
  await initializePlatform(options);
  return load();
};
