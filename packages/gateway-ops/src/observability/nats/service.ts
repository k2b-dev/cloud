import { readFileSync } from "node:fs";
import { connections } from "@k2b/cloud";
import { connect, credsAuthenticator, nkeyAuthenticator } from "@nats-io/transport-node";
import { z } from "zod";
import { app } from "../../config";
import { credsContentAuthenticator, systemAccessKind } from "./settings";

// The system JSZ API paginates accounts, not streams. Never request account
// expansion there: account inventory uses the separately authenticated JS API.
const REQUEST_TIMEOUT_MS = 1_500;
const SCAN_TIMEOUT_MS = 5_000;
const MAX_SCAN_PAGES = 16;
const number = z.number().finite().nonnegative();
const peerSchema = z.object({ name: z.string(), current: z.boolean().optional(), offline: z.boolean().optional(), lag: number.optional() });
const clusterSchema = z.object({ name: z.string().optional(), leader: z.string().optional(), replicas: z.array(peerSchema).optional() });
const streamSchema = z.object({
  config: z.object({
    name: z.string(),
    storage: z.string(),
    num_replicas: number,
    max_bytes: z.number(),
    max_msgs: z.number(),
    max_age: number.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  state: z.object({ messages: number, bytes: number, consumer_count: number }),
  cluster: clusterSchema.optional(),
});
const consumerSchema = z.object({
  name: z.string(),
  num_pending: number,
  num_ack_pending: number,
  num_redelivered: number,
  cluster: clusterSchema.optional(),
});
const pageSchema = z.object({ total: number, offset: number, limit: number });
const streamsSchema = pageSchema.extend({ streams: z.array(streamSchema).default([]) });
const consumersSchema = pageSchema.extend({ consumers: z.array(consumerSchema).default([]) });
const nodeSchema = z.object({
  server: z.object({ id: z.string(), name: z.string(), cluster: z.string().optional(), ver: z.string() }),
  data: z.object({
    disabled: z.boolean().optional(),
    memory: number.optional(),
    storage: number.optional(),
    streams: number.optional(),
    consumers: number.optional(),
    config: z.object({ max_memory: z.number().optional(), max_storage: z.number().optional() }).optional(),
    meta_cluster: clusterSchema.extend({ cluster_size: number.optional() }).optional(),
  }),
});
const processSchema = z.object({ server: z.object({ id: z.string() }), data: z.object({ mem: number }) });
export type NatsDiagnosticStatus = "not_configured" | "available" | "partial" | "unavailable";
export type NatsConnectionConfig = {
  servers: string[];
  credsFile?: string;
  tlsCaFile?: string;
  creds?: string;
  seed?: string;
  tlsCa?: string;
};
export type NatsDiagnosticsConfig = { admin: NatsConnectionConfig; application: NatsConnectionConfig; adminSettingsUnavailable?: true };
export type NatsReplica = { name: string; current: boolean | null; offline: boolean | null; lag: number | null };
export type NatsCluster = { name: string | null; leader: string | null; replicas: NatsReplica[] };
export type NatsStream = {
  name: string;
  kind: "stream" | "kv" | "object_store";
  storage: string;
  messages: number;
  bytes: number;
  consumers: number;
  replicas: number;
  maxBytes: number;
  maxMessages: number;
  maxAgeMs: number | null;
  deadLetter: boolean;
  cluster: NatsCluster | null;
  sync: { namespace: string; owner: string; kind: string; id: string } | null;
};
export type NatsConsumer = { name: string; pending: number; ackPending: number; redelivered: number; cluster: NatsCluster | null };
export type NatsNode = {
  id: string;
  name: string;
  version: string;
  clusterName: string | null;
  jetstreamEnabled: boolean;
  memory: number | null;
  processMemory: number | null;
  storage: number | null;
  maxMemory: number | null;
  maxStorage: number | null;
  streams: number | null;
  consumers: number | null;
  meta: NatsCluster | null;
  expectedNodes: number | null;
};
export type NatsInventorySummary = {
  status: NatsDiagnosticStatus;
  issue?: string;
  streams: NatsStream[];
  total: number | null;
  sampledAt: string;
};
export type NatsDiagnostics = {
  sampledAt: string;
  cluster: { status: NatsDiagnosticStatus; issue?: string; nodes: NatsNode[]; settingsUnavailable?: true };
  inventory: {
    status: NatsDiagnosticStatus;
    issue?: string;
    streams: NatsStream[];
    total: number | null;
    offset: number;
    nextOffset: number | null;
    consumers: NatsConsumer[];
    consumerTotal: number | null;
    consumerStream: string | null;
    consumerOffset: number;
    consumerNextOffset: number | null;
  };
};
export type NatsDiagnosticsOptions = { streamOffset?: number; consumerStream?: string; consumerOffset?: number };
export const natsAccountDiagnosticsConfig = (): NatsDiagnosticsConfig => ({
  admin: { servers: [] },
  application: { servers: connections().nats.servers, creds: connections().nats.creds, tlsCa: connections().nats.ca },
});
export const natsDiagnosticsConfig = async (): Promise<NatsDiagnosticsConfig> => {
  try {
    const states = await Promise.all([
      app.settings.read("gateway.nats_admin_servers"),
      app.settings.read("gateway.nats_admin_access_kind"),
      app.settings.read("gateway.nats_admin_access"),
      app.settings.read("gateway.nats_admin_tls_ca"),
    ]);
    const servers = states[0].value;
    const kind = states[1].value;
    const access = states[2].value;
    const ca = states[3].value;
    // A format switch may be saved before its replacement secret. Never try the
    // previous credentials under the new format. An explicitly empty access
    // setting retains the existing anonymous-connection behavior.
    const matches = states.every((state) => state.stored !== "unreadable") && (!access || systemAccessKind(access) === kind);
    return {
      admin: {
        servers: matches ? servers : [],
        ...(access && kind === "creds" ? { creds: access } : {}),
        ...(access && kind === "nkey" ? { seed: access } : {}),
        ...(ca ? { tlsCa: ca } : {}),
      },
      application: natsAccountDiagnosticsConfig().application,
    };
  } catch {
    return { ...natsAccountDiagnosticsConfig(), adminSettingsUnavailable: true };
  }
};
const dial = (config: NatsConnectionConfig, role: string) => {
  if (config.creds && config.seed) throw new Error("NATS diagnostics authentication modes are mutually exclusive");
  return connect({
    servers: config.servers,
    name: `cloud-gateway-ops-diagnostics-${role}`,
    timeout: REQUEST_TIMEOUT_MS,
    reconnect: false,
    ignoreClusterUpdates: true,
    ...(config.seed ? { authenticator: nkeyAuthenticator(new TextEncoder().encode(config.seed)) } : {}),
    ...(config.creds ? { authenticator: credsContentAuthenticator(config.creds) } : {}),
    ...(config.credsFile ? { authenticator: credsAuthenticator(readFileSync(config.credsFile)) } : {}),
    ...(config.tlsCa ? { tls: { ca: config.tlsCa } } : config.tlsCaFile ? { tls: { caFile: config.tlsCaFile } } : {}),
  });
};
type DiagnosticMessage = { json(): unknown };
type DiagnosticConnection = {
  request(subject: string, data: string, options: { timeout: number }): Promise<DiagnosticMessage>;
  requestMany(subject: string, data: string, options: { strategy: "timer"; maxWait: number }): Promise<AsyncIterable<DiagnosticMessage>>;
  close(): Promise<void>;
};
export type NatsDiagnosticsDependencies = { connect: (config: NatsConnectionConfig, role: string) => Promise<DiagnosticConnection> };
const defaultDependencies: NatsDiagnosticsDependencies = { connect: dial };
export const natsDiagnosticsDependencies = defaultDependencies;
const cluster = (value: z.infer<typeof clusterSchema> | undefined): NatsCluster | null =>
  value
    ? {
        name: value.name ?? null,
        leader: value.leader ?? null,
        replicas: (value.replicas ?? []).map((peer) => ({
          name: peer.name,
          current: peer.current ?? null,
          offline: peer.offline ?? null,
          lag: peer.lag ?? null,
        })),
      }
    : null;
const stream = (value: z.infer<typeof streamSchema>): NatsStream => {
  const metadata = value.config.metadata;
  const namespace = metadata?.["sync.namespace"],
    owner = metadata?.["sync.owner"],
    kind = metadata?.["sync.kind"],
    id = metadata?.["sync.id"];
  return {
    name: value.config.name,
    kind: value.config.name.startsWith("KV_") ? "kv" : value.config.name.startsWith("OBJ_") ? "object_store" : "stream",
    storage: value.config.storage,
    replicas: value.config.num_replicas,
    maxBytes: value.config.max_bytes,
    maxMessages: value.config.max_msgs,
    maxAgeMs: value.config.max_age === undefined ? null : value.config.max_age / 1_000_000,
    deadLetter: Boolean(namespace && owner && kind && id && /^S6_(QD|JD|TD)_/.test(value.config.name)),
    messages: value.state.messages,
    bytes: value.state.bytes,
    consumers: value.state.consumer_count,
    cluster: cluster(value.cluster),
    sync: namespace && owner && kind && id ? { namespace, owner, kind, id } : null,
  };
};
const validOffset = (offset = 0) => {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid NATS inventory offset");
  return offset;
};
const nextOffset = (offset: number, count: number, total: number) => (count > 0 && offset + count < total ? offset + count : null);

export const getNatsClusterDiagnostics = async (
  config: NatsDiagnosticsConfig | Promise<NatsDiagnosticsConfig> = natsDiagnosticsConfig(),
  dependencies = defaultDependencies,
): Promise<NatsDiagnostics["cluster"]> => {
  config = await config;
  if (config.adminSettingsUnavailable)
    return {
      status: "unavailable",
      nodes: [],
      issue: "NATS diagnostics settings could not be read. Retry when the settings service is available.",
      settingsUnavailable: true,
    };
  if (!config.admin.servers.length) return { status: "not_configured", nodes: [] };
  let connection: DiagnosticConnection | undefined;
  const nodes = new Map<string, NatsNode>();
  let incomplete = false;
  try {
    connection = await dependencies.connect(config.admin, "system");
    const system = connection;
    const processMemory = new Map<string, number>();
    const results = await Promise.allSettled([
      (async () => {
        const replies = await system.requestMany("$SYS.REQ.SERVER.PING.VARZ", "{}", {
          strategy: "timer",
          maxWait: REQUEST_TIMEOUT_MS,
        });
        for await (const reply of replies) {
          const parsed = processSchema.safeParse(reply.json());
          if (parsed.success) processMemory.set(parsed.data.server.id, parsed.data.data.mem);
          else incomplete = true;
        }
      })(),
      (async () => {
        const replies = await system.requestMany("$SYS.REQ.SERVER.PING.JSZ", JSON.stringify({}), {
          strategy: "timer",
          maxWait: REQUEST_TIMEOUT_MS,
        });
        for await (const reply of replies) {
          const parsed = nodeSchema.safeParse(reply.json());
          if (!parsed.success) {
            incomplete = true;
            continue;
          }
          const { server, data } = parsed.data;
          nodes.set(server.id, {
            id: server.id,
            name: server.name,
            version: server.ver,
            clusterName: server.cluster ?? null,
            jetstreamEnabled: !data.disabled,
            memory: data.memory ?? null,
            processMemory: null,
            storage: data.storage ?? null,
            maxMemory: data.config?.max_memory ?? null,
            maxStorage: data.config?.max_storage ?? null,
            streams: data.streams ?? null,
            consumers: data.consumers ?? null,
            meta: cluster(data.meta_cluster),
            expectedNodes: data.meta_cluster?.cluster_size ?? null,
          });
        }
      })(),
    ]);
    if (results.some((result) => result.status === "rejected")) incomplete = true;
    for (const node of nodes.values()) {
      node.processMemory = processMemory.get(node.id) ?? null;
      if (node.processMemory === null) incomplete = true;
    }
    const values = [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const node of values) {
      if (
        node.expectedNodes &&
        values.filter((other) => other.clusterName === node.clusterName && other.jetstreamEnabled).length < node.expectedNodes
      )
        incomplete = true;
    }
    return {
      status: !values.length ? "unavailable" : incomplete ? "partial" : "available",
      nodes: values,
      ...(!values.length || incomplete ? { issue: "NATS system diagnostics returned no response or an incomplete node snapshot." } : {}),
    };
  } catch {
    return {
      status: nodes.size ? "partial" : "unavailable",
      nodes: [...nodes.values()],
      issue: "NATS system diagnostics unavailable. Check the dedicated connection and system-account permissions.",
    };
  } finally {
    await connection?.close();
  }
};

export const getNatsDiagnostics = async (
  options: NatsDiagnosticsOptions = {},
  config: NatsDiagnosticsConfig | Promise<NatsDiagnosticsConfig> = natsDiagnosticsConfig(),
  dependencies = defaultDependencies,
): Promise<NatsDiagnostics> => {
  config = await config;
  const offset = validOffset(options.streamOffset),
    consumerOffset = validOffset(options.consumerOffset);
  if (options.consumerStream && /[.\s*>/\\]/u.test(options.consumerStream)) throw new Error("Invalid NATS stream name");
  const clusterPromise = getNatsClusterDiagnostics(config, dependencies);
  const inventory: NatsDiagnostics["inventory"] = {
    status: config.application.servers.length ? "unavailable" : "not_configured",
    streams: [],
    total: null,
    offset,
    nextOffset: null,
    consumers: [],
    consumerTotal: null,
    consumerStream: options.consumerStream ?? null,
    consumerOffset,
    consumerNextOffset: null,
  };
  let connection: DiagnosticConnection | undefined;
  try {
    if (config.application.servers.length) {
      connection = await dependencies.connect(config.application, "account");
      const response = await connection.request("$JS.API.STREAM.LIST", JSON.stringify({ offset }), { timeout: REQUEST_TIMEOUT_MS });
      const page = streamsSchema.parse(response.json());
      inventory.streams = page.streams.map(stream);
      inventory.total = page.total;
      inventory.nextOffset = nextOffset(offset, page.streams.length, page.total);
      inventory.status = page.streams.length === 0 && offset < page.total ? "partial" : "available";
      if (options.consumerStream) {
        const response = await connection.request(
          `$JS.API.CONSUMER.LIST.${options.consumerStream}`,
          JSON.stringify({ offset: consumerOffset }),
          { timeout: REQUEST_TIMEOUT_MS },
        );
        const page = consumersSchema.parse(response.json());
        inventory.consumers = page.consumers.map((value) => ({
          name: value.name,
          pending: value.num_pending,
          ackPending: value.num_ack_pending,
          redelivered: value.num_redelivered,
          cluster: cluster(value.cluster),
        }));
        inventory.consumerTotal = page.total;
        inventory.consumerNextOffset = nextOffset(consumerOffset, page.consumers.length, page.total);
        if (!page.consumers.length && consumerOffset < page.total) inventory.status = "partial";
      }
    }
  } catch {
    inventory.status = inventory.total === null ? "unavailable" : "partial";
    inventory.issue =
      "NATS account inventory unavailable or incomplete. Check account credentials and read-only JetStream API permissions.";
  } finally {
    await connection?.close();
  }
  return { sampledAt: new Date().toISOString(), cluster: await clusterPromise, inventory };
};

/** Complete account scan only when status=available; all other states must not be reported as zero. */
export const getNatsInventorySummary = async (
  config = natsAccountDiagnosticsConfig(),
  dependencies = defaultDependencies,
): Promise<NatsInventorySummary> => {
  const result: NatsInventorySummary = { status: "not_configured", streams: [], total: null, sampledAt: new Date().toISOString() };
  if (!config.application.servers.length) return result;
  let connection: DiagnosticConnection | undefined;
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  try {
    connection = await dependencies.connect(config.application, "account-summary");
    const unique = new Map<string, NatsStream>();
    let offset = 0;
    for (let index = 0; index < MAX_SCAN_PAGES && Date.now() < deadline; index++) {
      const reply = await connection.request("$JS.API.STREAM.LIST", JSON.stringify({ offset }), {
        timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())),
      });
      const page = streamsSchema.parse(reply.json());
      if (result.total !== null && result.total !== page.total) break;
      result.total = page.total;
      for (const value of page.streams) unique.set(value.config.name, stream(value));
      result.streams = [...unique.values()];
      const next = nextOffset(offset, page.streams.length, page.total);
      if (next === null) {
        result.status = unique.size === page.total ? "available" : "partial";
        return result;
      }
      offset = next;
    }
    result.status = "partial";
    result.issue = "NATS account inventory exceeded the bounded scan or changed during pagination.";
  } catch {
    result.status = result.total === null ? "unavailable" : "partial";
    result.issue = "NATS account inventory unavailable or incomplete.";
  } finally {
    await connection?.close();
  }
  return result;
};
