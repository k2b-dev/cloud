import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@k2b/cloud/config";
import { RedisClient } from "bun";
import { z } from "zod";
import { stableCustomAppStringify } from "../custom-apps/stable-value";
import { canonicalizeDslQuery } from "../query-dsl/canonical";
import { type DslResolverContext, resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import type { DslQueryAst } from "../query-dsl/types";

// Bump when the resolver/canonical plan contract or its semantics change.
const COMPILER_VERSION = "1";
// An application budget, independent of query/user counts: at most 16 MiB of
// payloads per compiler generation. Hash collisions only cause cache misses.
const SLOT_COUNT = 256;
const MAX_ENTRY_BYTES = 64 * 1024;
const TTL_SECONDS = 300;
const CACHE_WAIT_MS = 25;
const envelopeSchema = z.object({ fingerprint: z.string(), payload: z.string(), signature: z.string() }).strict();

type PreparationStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};

/** The cache owns no permissions or schema freshness. Callers load current
 * metadata and bind request values before using it; SQL, record-dependent search
 * expansion, NOW(), cursors and execution remain outside this boundary. */
export const createGqlPreparationCache = (store: PreparationStore, signingKey: string) => {
  const cacheKey = createHmac("sha256", signingKey).update("grids:gql-preparation").digest();
  const prepare = async <T extends { ok: boolean }>(
    kind: "resolve" | "canonical",
    ast: DslQueryAst,
    context: DslResolverContext,
    compile: () => T,
  ): Promise<T> => {
    if (!signingKey) return compile();
    const compilerContext = {
      documentMetadata: context.documentMetadata,
      currentTable: context.currentTable,
      tables: context.tables,
      views: context.views,
      fieldsByTableId: context.fieldsByTableId,
    } satisfies Record<keyof DslResolverContext, unknown>;
    const fingerprint = createHash("sha256")
      .update(
        stableCustomAppStringify({
          version: COMPILER_VERSION,
          kind,
          ast,
          context: compilerContext,
        }),
      )
      .digest("hex");
    const slot = Number.parseInt(fingerprint.slice(0, 8), 16) % SLOT_COUNT;
    const key = `grids:gql-preparation:v${COMPILER_VERSION}:${slot}`;
    const sign = (payload: string) => createHmac("sha256", cacheKey).update(fingerprint).update("\0").update(payload).digest();
    try {
      const cached = await store.get(key);
      if (cached !== null && Buffer.byteLength(cached) <= MAX_ENTRY_BYTES) {
        const envelope = envelopeSchema.safeParse(JSON.parse(cached));
        if (envelope.success && envelope.data.fingerprint === fingerprint) {
          const signature = Buffer.from(envelope.data.signature, "hex");
          const expected = sign(envelope.data.payload);
          if (signature.length === expected.length && timingSafeEqual(signature, expected)) {
            // This is an internal typed codec, not an input API: the signature
            // authenticates bytes written below by this compiler version, for
            // this exact AST and current resolver context. Never accept unsigned
            // plan JSON. Decode anew so callers cannot mutate another request.
            return JSON.parse(envelope.data.payload) as T;
          }
        }
      }
    } catch {
      // Corrupt or unavailable cache entries are ordinary misses.
    }
    const result = compile();
    if (!result.ok) return result;
    try {
      const payload = JSON.stringify(result);
      const entry = JSON.stringify({ fingerprint, payload, signature: sign(payload).toString("hex") });
      // Filling is advisory and has its own bounded transport deadline. A slow
      // fill must not add a second cache wait after successful compilation.
      if (Buffer.byteLength(entry) <= MAX_ENTRY_BYTES) void store.set(key, entry).catch(() => {});
    } catch {
      // Only compilation can affect the result; failed fills never fail a query.
    }
    return result;
  };
  return {
    resolve: (ast: DslQueryAst, context: DslResolverContext) =>
      prepare("resolve", ast, context, () => resolveDslQueryToQueryPlan(ast, context)),
    canonicalize: (ast: DslQueryAst, context: DslResolverContext) =>
      prepare("canonical", ast, context, () => canonicalizeDslQuery(ast, context)),
  };
};

let client: RedisClient | undefined;
let connecting: Promise<void> | undefined;
let reconnectAfter = 0;
const connectedClient = (): RedisClient | null => {
  if (Date.now() < reconnectAfter) return null;
  if (!client) {
    const url = env.REDIS_URL;
    if (!url) return null;
    client = new RedisClient(url, { enableOfflineQueue: false });
  }
  // Never delay a query for connection setup; also recover after Bun exhausts
  // automatic reconnect attempts during a longer outage.
  if (!client.connected && !connecting) {
    connecting = client
      .connect()
      .catch(() => {})
      .finally(() => {
        connecting = undefined;
      });
  }
  return client.connected ? client : null;
};

export const withPreparationCacheDeadline = async <T>(connection: Pick<RedisClient, "close">, command: () => Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      command(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Close only this cache's connection: pending commands must not build
          // up when Valkey is connected but unresponsive.
          if (client === connection) {
            client = undefined;
            // One cache timeout should not make every subsequent request pay
            // another deadline while an overloaded Valkey is recovering.
            reconnectAfter = Date.now() + 1_000;
          }
          try {
            connection.close();
          } catch {
            // A connection already closed by another deadline is harmless.
          } finally {
            reject(new Error("GQL preparation cache deadline"));
          }
        }, CACHE_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const gqlPreparation = createGqlPreparationCache(
  {
    get: async (key) => {
      const connection = connectedClient();
      return connection ? withPreparationCacheDeadline(connection, () => connection.get(key)) : null;
    },
    set: async (key, value) => {
      const connection = connectedClient();
      if (connection) await withPreparationCacheDeadline(connection, () => connection.set(key, value, "EX", TTL_SECONDS));
    },
  },
  env.APP_SECRET,
);
