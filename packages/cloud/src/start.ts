// Keep this entry independent of the platform barrel and application modules.
import { parseAppKey } from "./app-key";
import { env } from "./config/env";
import { bootstrapConnections } from "./runtime/bootstrap-client";
import type { BootstrapResponse } from "./runtime/bootstrap-protocol";
import { initializeClients } from "./runtime/clients";
import { bindConnections, hasConnections } from "./runtime/connections";
import { resolveConnections } from "./runtime/resolve-connections";

export type PlatformStartOptions = {
  appId: string;
  /** Core and Gateway always use infrastructure environment values. */
  source?: "env";
};

let initializing = false;

/** Initialize before importing any application module, also in dev and data workers. */
export const initializePlatform = async ({ appId, source }: PlatformStartOptions): Promise<void> => {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(appId)) throw new Error("Platform start requires a valid appId");
  if (initializing || hasConnections()) throw new Error("Platform has already started");
  initializing = true;
  try {
    const keyValue = env.CLOUD_APP_KEY;
    const envOnly = source === "env" || appId === "core" || appId === "gateway";
    if (keyValue && envOnly) throw new Error("App keys are forbidden in forced env mode (including Core and Gateway)");
    let bootstrap: BootstrapResponse | undefined;
    if (keyValue) {
      // Parsing never prints the private value. A present invalid key cannot fall back to env.
      const key = parseAppKey(keyValue);
      if (key.appId !== appId) throw new Error("App-key appId does not match the declared application");
      bootstrap = await bootstrapConnections(key, env.CLOUD_CORE_INTERNAL_ORIGIN);
    }
    const resolved = resolveConnections({ appId, core: bootstrap?.connections });
    resolved.bootstrap = {
      mode: bootstrap ? "core" : "env",
      ...(bootstrap ? { keyId: bootstrap.identity.keyId } : {}),
      sources: resolved.sources,
      keyFormat: "cloud-app-key-v1",
      protocol: 1,
    };
    bindConnections(resolved);
    try {
      await initializeClients();
    } catch (error) {
      bindConnections(undefined);
      throw error;
    }
  } finally {
    initializing = false;
  }
};

export const startPlatform = async <T>({ load, ...options }: PlatformStartOptions & { load: () => Promise<T> }): Promise<T> => {
  await initializePlatform(options);
  return load();
};
