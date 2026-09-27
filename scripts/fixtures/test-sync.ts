/**
 * JetStream housekeeping for integration tests.
 *
 * Tests share one JetStream account and isolate their @k2b/sync resources only
 * by namespace. Locally, that is the TEST account of the development broker,
 * whose storage limit keeps tests away from the development account.
 * JetStream reserves every stream's full size against that limit (1 GiB per
 * topic, job, and dead-letter stream by default), so a namespace a test leaves
 * behind blocks 1.5 to 2 GiB for a few kilobytes of data. Every test namespace
 * therefore starts with `test-`. The fixture deletes a test process's
 * namespaces once its tests are done, and `bun run test` sweeps the namespaces
 * that killed processes leave behind.
 *
 * Streams are selected only through the `sync.namespace` metadata that
 * @k2b/sync writes, so other namespaces (`dev`, production) and streams
 * without that metadata are never touched.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { connectTestNats } from "./test-nats";

export const testNamespacePrefix = "test-";

/**
 * Age after which a test namespace counts as abandoned. No test process runs
 * longer than the whole integration job may run in CI (40 minutes), so a
 * namespace whose streams are all older than an hour belongs to a process
 * that is gone. Recent writes prove nothing: the broker keeps firing Sync
 * schedules into a killed process's scheduler stream.
 */
export const staleAfterMs = 60 * 60_000;

/** The members of a JetStream `StreamInfo` this module reads. */
export type StreamInfo = {
  config: { name: string; metadata?: Record<string, string> };
  created: string;
};

type ApiError = { err_code?: number; description?: string };
const streamNotFound = 10059;
const apiTimeout = { timeout: 5_000 };

const withConnection = async <T>(run: (connection: NatsConnection) => Promise<T>): Promise<T> => {
  const connection = await connectTestNats({ name: "cloud-test-cleanup", ignoreClusterUpdates: true }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cleaning up test Sync namespaces failed: ${message}`, { cause: error });
  });
  try {
    return await run(connection);
  } finally {
    await connection.close();
  }
};

const listStreams = async (connection: NatsConnection): Promise<StreamInfo[]> => {
  const streams: StreamInfo[] = [];
  for (;;) {
    const page = (await connection.request("$JS.API.STREAM.LIST", JSON.stringify({ offset: streams.length }), apiTimeout)).json<{
      total: number;
      streams: StreamInfo[] | null;
      error?: ApiError;
    }>();
    if (page.error) throw new Error(`Listing JetStream streams failed: ${page.error.description}`);
    streams.push(...(page.streams ?? []));
    if (!page.streams?.length || streams.length >= page.total) return streams;
  }
};

const deleteStreams = async (connection: NatsConnection, names: string[]): Promise<void> => {
  for (const name of names) {
    const response = (await connection.request(`$JS.API.STREAM.DELETE.${name}`, undefined, apiTimeout)).json<{
      success?: boolean;
      error?: ApiError;
    }>();
    // A concurrent cleanup may have deleted the stream first.
    if (!response.success && response.error?.err_code !== streamNotFound) {
      throw new Error(`Deleting JetStream stream ${name} failed: ${response.error?.description ?? "no success"}`);
    }
  }
};

const namespaceOf = (stream: StreamInfo): string | undefined => stream.config.metadata?.["sync.namespace"];

/** Deletes the streams of test namespace `namespace` and of every namespace derived from it (`<namespace>-…`). */
export const deleteTestNamespace = async (namespace: string): Promise<number> => {
  if (!namespace.startsWith(testNamespacePrefix)) {
    throw new Error(`Refusing to delete Sync namespace "${namespace}": test namespaces start with "${testNamespacePrefix}"`);
  }
  return withConnection(async (connection) => {
    const names = (await listStreams(connection))
      .filter((stream) => {
        const own = namespaceOf(stream);
        return own === namespace || own?.startsWith(`${namespace}-`);
      })
      .map((stream) => stream.config.name);
    await deleteStreams(connection, names);
    return names.length;
  });
};

/**
 * Stream names per test namespace whose every stream was created more than
 * `staleAfterMs` before `now`. A namespace with any younger stream, and every
 * namespace without the test prefix, is left alone.
 */
export const staleTestNamespaces = (streams: StreamInfo[], now: number): Map<string, string[]> => {
  const byNamespace = new Map<string, StreamInfo[]>();
  for (const stream of streams) {
    const namespace = namespaceOf(stream);
    if (namespace?.startsWith(testNamespacePrefix)) byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), stream]);
  }
  const cutoff = now - staleAfterMs;
  // An unparsable timestamp is NaN and never older than the cutoff.
  const abandoned = (stream: StreamInfo) => Date.parse(stream.created) < cutoff;
  const stale = new Map<string, string[]>();
  for (const [namespace, members] of byNamespace) {
    if (!members.every(abandoned)) continue;
    stale.set(
      namespace,
      members.map((stream) => stream.config.name),
    );
  }
  return stale;
};

/** Deletes the test namespaces that killed or timed-out test processes left behind. */
export const sweepStaleTestNamespaces = async (now = Date.now()): Promise<{ namespaces: number; streams: number }> =>
  withConnection(async (connection) => {
    const stale = staleTestNamespaces(await listStreams(connection), now);
    const names = [...stale.values()].flat();
    await deleteStreams(connection, names);
    return { namespaces: stale.size, streams: names.length };
  });
