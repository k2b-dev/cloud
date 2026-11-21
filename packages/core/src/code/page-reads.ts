import { getCapabilityCodeReadFacts, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import type { CodeRoute } from "@k2b/cloud/code";
import { CloudResourceReaderViewSchema } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { z } from "zod";
import type { CodeRouteRead } from "./requests";

/** The read check could not finish (a provider or the registry did not answer). Hosting answers 503, never the data. */
export class CodeRouteReadsUnavailable extends Error {}

/** Readers asked at once for one answer; the run's call budget bounds how many there are in total. */
const READ_CHECK_CONCURRENCY = 4;
const REFUSED = new Set(["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED"]);
const ReaderDataSchema = z.object({ view: CloudResourceReaderViewSchema });

type Facts = NonNullable<Awaited<ReturnType<typeof getCapabilityCodeReadFacts>>>;
const appOf = (qualified: string) => qualified.slice(0, qualified.indexOf("."));

/**
 * G1: Cloud delivers a Code route's answer only to a visitor who may read every resource the route read: the target or
 * a ref of a succeeded Query, or the resource whose type reader it called. Each is checked with the type's reader under
 * the visitor's own authority, so the check is the same one the app applies everywhere else.
 *
 * `audience: "owner-data"` turns the check off on purpose; it is in the manifest and the admin review. A public route
 * has no visitor who could read anything, so its reads need `owner-data`, and types an app declares in
 * `code.noPublicRoutes` are refused on a public route even then.
 */
export async function checkCodeRouteReads(input: {
  reads: readonly CodeRouteRead[];
  route: Pick<CodeRoute, "public" | "audience">;
  /** The signed-in visitor of a route that is not public; `null` on a public route. */
  visitor: RequestAuthority | null;
  locale: string;
  signal: AbortSignal;
}): Promise<"deliver" | "forbidden"> {
  if (input.reads.length === 0) return "deliver";
  const facts = new Map<string, Facts>();
  const factsOf = async (appId: string): Promise<Facts> => {
    const known = facts.get(appId);
    if (known) return known;
    input.signal.throwIfAborted();
    const loaded = await getCapabilityCodeReadFacts(appId);
    if (!loaded) throw new CodeRouteReadsUnavailable(`Capability registry entry unavailable: ${appId}`);
    facts.set(appId, loaded);
    return loaded;
  };
  const resources = new Map<string, { type: string; id: string }>();
  for (const read of input.reads) {
    let ref: { type: string; id: string } | null = read.kind === "target" ? read.ref : null;
    if (read.kind === "reader") {
      const type = (await factsOf(appOf(read.capability))).readers[read.capability];
      // A Query that is no type's reader reads no named resource; Code's handler checks own data (09.11.).
      if (type) ref = { type, id: read.id };
    }
    if (ref) resources.set(JSON.stringify([ref.type, ref.id]), ref);
  }
  if (resources.size === 0) return "deliver";
  if (input.route.public) {
    for (const ref of resources.values()) if ((await factsOf(appOf(ref.type))).noPublicRoutes.includes(ref.type)) return "forbidden";
    return input.route.audience === "owner-data" ? "deliver" : "forbidden";
  }
  if (input.route.audience === "owner-data") return "deliver";
  const visitor = input.visitor;
  if (!visitor) return "forbidden";
  const pending = [...resources.values()];
  let forbidden = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const worker = async () => {
    for (let ref = pending.shift(); ref && !forbidden; ref = pending.shift()) {
      const appId = appOf(ref.type);
      const reader = (await factsOf(appId)).typeReaders[ref.type];
      // A resource Cloud cannot check is not delivered.
      if (!reader) {
        forbidden = true;
        break;
      }
      const result = await invokeCapabilityWithDataSchema(
        { appId, capabilityId: reader, kind: "query", input: { id: ref.id } },
        ReaderDataSchema,
        { authority: visitor, locale: input.locale, signal },
      );
      if (result.ok) continue;
      if (REFUSED.has(result.error.code)) {
        forbidden = true;
        break;
      }
      if (forbidden) break;
      throw new CodeRouteReadsUnavailable(`Resource reader unavailable: ${result.error.code}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(READ_CHECK_CONCURRENCY, pending.length) }, worker));
  } catch (error) {
    if (!forbidden) throw error;
  } finally {
    controller.abort();
  }
  input.signal.throwIfAborted();
  return forbidden ? "forbidden" : "deliver";
}
