/** Startup snapshot. Connection credentials never flow back into the process environment. */
export type ConnectionSource = "env" | "core";
export type PlatformConnectionValues = {
  database: { url: string };
  valkey: { url: string };
  nats: {
    servers: string[];
    namespace: string;
    replicas: 1 | 3 | 5;
    ignoreClusterUpdates: boolean;
    /** Mounted credentials and CA files are read once; these are contents, not paths. */
    creds?: string;
    ca?: string;
  };
  appSecret: { current: string; previous?: string; next?: string };
};
export type PlatformConnectionSources = {
  [Group in keyof PlatformConnectionValues]: { [Key in keyof PlatformConnectionValues[Group]]: ConnectionSource };
};
export type PlatformConnections = PlatformConnectionValues & {
  appId: string;
  sources: PlatformConnectionSources;
};

let current: PlatformConnections | undefined;

export const connections = (): PlatformConnections => {
  if (!current)
    throw new Error("connections() used before platform start; use @k2b/cloud/start, the Cloud build entry or development preload");
  return current;
};

/** Internal startup binding; tests replace it only after closing their previous clients. */
export const bindConnections = (value: PlatformConnections | undefined): void => {
  current = value;
};
export const hasConnections = (): boolean => current !== undefined;
