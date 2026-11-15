import { z } from "zod";
import { type listApps, listCapabilities } from "../_internal/registry";
import { type CapabilityDispatchParams, dispatchCapability } from "../api/capabilities";
import {
  type CloudResourceRef,
  capabilityResultSchema,
  cloudResourceRefAppId,
  LinkedCloudResourceReferenceSchema,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import { discoverableAppEntries } from "../services/app-discovery";
import { LOCALE_HEADER } from "../shared/locale";
import { addCloudResourceHrefs } from "./resource-refs";

/**
 * Reading a Cloud reference by the reading person: the registry once per request, then each reference through its
 * type's canonical reader Query with that person's authority. A reference the person may not read, or that is gone,
 * returns nothing; a failed read never names anything. The chat's recent resources and its view tables share this.
 */
export type AiResourceReaderDependencies = {
  listRegistry?: () => Promise<CapabilityRegistryEntry[]>;
  listApps?: typeof listApps;
  dispatch?: (params: CapabilityDispatchParams) => Promise<Response>;
};

export type AiResourceReading = {
  app: CapabilityRegistryEntry;
  /** The reader's own reference, always with its title. */
  ref: z.output<typeof LinkedCloudResourceReferenceSchema> & { title: string };
};

const ReaderResult = capabilityResultSchema(z.unknown(), { consumer: true });

/** Enforce the shared budget even when a dependency ignores cancellation. */
export const withinBudget = async <T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> => {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([run(), aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/** The apps the person may discover, read once for every reference of one request. */
export const readableApps = (input: { authority: RequestAuthority; signal: AbortSignal; dependencies?: AiResourceReaderDependencies }) =>
  withinBudget(input.signal, async () =>
    discoverableAppEntries(input.authority, await (input.dependencies?.listRegistry ?? listCapabilities)(), input.dependencies?.listApps),
  ).catch(() => [] as CapabilityRegistryEntry[]);

/** One reference through its type's reader with the person's authority; null when it cannot be read or named. */
export const readAiResource = async (input: {
  ref: CloudResourceRef;
  apps: readonly CapabilityRegistryEntry[];
  authority: RequestAuthority;
  locale: string;
  signal: AbortSignal;
  /** The route the reading belongs to, for the audit of the dispatched Query. */
  path: string;
  dependencies?: AiResourceReaderDependencies;
}): Promise<AiResourceReading | null> => {
  const { ref, signal } = input;
  try {
    signal.throwIfAborted();
    const appId = cloudResourceRefAppId(ref);
    const app = input.apps.find((entry) => entry.appId === appId);
    const reader = app && resolveCapabilityResourceReader(app.manifest, ref);
    if (!app || !reader) return null;
    const response = await withinBudget(signal, () =>
      (input.dependencies?.dispatch ?? dispatchCapability)({
        request: new Request(`http://localhost${input.path}`, {
          method: "POST",
          headers: { [LOCALE_HEADER]: input.locale, "x-request-id": crypto.randomUUID() },
          signal,
        }),
        kind: "queries",
        origin: "assistant",
        appId: app.appId,
        capabilityId: reader.localId,
        input: { id: ref.id },
        authority: input.authority,
        locale: input.locale,
      }),
    );
    if (!response.ok) return null;
    const answer = ReaderResult.parse(addCloudResourceHrefs(await withinBudget(signal, () => response.json()), input.apps));
    const matched = answer.refs?.find((entry) => entry.type === ref.type && entry.id === ref.id);
    const own = matched ? LinkedCloudResourceReferenceSchema.parse(matched) : undefined;
    if (!own?.title?.trim()) return null;
    return { app, ref: { ...own, title: own.title } };
  } catch {
    return null;
  }
};

/** At most this many references are named for one view; a table shows at most 100 rows. */
export const AI_RESOURCE_NAME_LIMIT = 100;
/** Readers run this many at a time, as the Code page reads its targets. */
const READER_CONCURRENCY = 8;
const keyOf = (ref: CloudResourceRef) => JSON.stringify([ref.type, ref.id]);

/**
 * Names references for the reading person in one batch: duplicates once, the registry once, at most
 * `AI_RESOURCE_NAME_LIMIT` reader calls, eight at a time. The result maps each named reference to its title and open
 * link; a missing entry means the person may not read it or it is gone.
 */
export async function nameAiResources(input: {
  refs: readonly CloudResourceRef[];
  authority: RequestAuthority;
  locale: string;
  signal: AbortSignal;
  path: string;
  dependencies?: AiResourceReaderDependencies;
}): Promise<Map<string, { title: string; href?: string }>> {
  const unique = new Map<string, CloudResourceRef>();
  for (const ref of input.refs) if (unique.size < AI_RESOURCE_NAME_LIMIT) unique.set(keyOf(ref), { type: ref.type, id: ref.id });
  const named = new Map<string, { title: string; href?: string }>();
  if (!unique.size) return named;
  const apps = await readableApps(input);
  const entries = [...unique];
  for (let offset = 0; offset < entries.length; offset += READER_CONCURRENCY) {
    await Promise.all(
      entries.slice(offset, offset + READER_CONCURRENCY).map(async ([key, ref]) => {
        const reading = await readAiResource({ ...input, ref, apps });
        if (reading?.ref.title) named.set(key, { title: reading.ref.title, ...(reading.ref.href ? { href: reading.ref.href } : {}) });
      }),
    );
  }
  return named;
}

export const aiResourceKey = keyOf;
