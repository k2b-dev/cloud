import { getCapabilityCodeReadFacts, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import type { CodeRoute } from "@k2b/cloud/code";
import { CLOUD_RESOURCE_ID_MAX_LENGTH, CloudResourceReaderViewSchema } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { z } from "zod";
import { isCodeAiOperation } from "./policy-contracts";
import type { CodeRouteRead } from "./requests";

/** The read check could not finish (a provider or the registry did not answer). Hosting answers 503, never the data. */
export class CodeRouteReadsUnavailable extends Error {}

/** Readers asked at once for one answer; the run's call budget bounds how many there are in total. */
const READ_CHECK_CONCURRENCY = 4;
/** A reader that says no, cannot find the resource, or refuses the ID as input: Cloud cannot show it to this visitor. */
const REFUSED = new Set(["FORBIDDEN", "NOT_FOUND", "APP_ACCESS_DENIED", "VALIDATION_FAILED", "BAD_INPUT"]);
const ReaderDataSchema = z.object({ view: CloudResourceReaderViewSchema });

type Facts = NonNullable<Awaited<ReturnType<typeof getCapabilityCodeReadFacts>>>;
const appOf = (qualified: string) => qualified.slice(0, qualified.indexOf("."));
/** The Code's own database and files belong to the Code, not to an app. */
const isCodeOwnData = (capability: string) => capability === "db.query" || capability.startsWith("core.code.file.");
/** AI reads no resource by itself; whatever it was given came from a call that is recorded on its own. */
const isUnnamedRead = (capability: string) => isCodeOwnData(capability) || isCodeAiOperation(capability);

/**
 * G1: Cloud delivers a Code route's answer only to a visitor who may read every resource the route read: the target or
 * a ref of a succeeded Query, or a resource an app-wide Query names in its input (a type reader's `id`, declared
 * `inputRefs` such as Pulse's `baseId`). Queries without such a resource (lists,
 * searches, other app-wide reads) stay the route handler's job on member routes. Each is checked with the type's reader under
 * the visitor's own authority, so the check is the same one the app applies everywhere else.
 *
 * `audience: "owner-data"` turns the check off on purpose; it is in the manifest and the admin review. A public route
 * has no visitor who could read anything, so any Query it calls needs `owner-data`, and an app that declares
 * `code.publicRoutes: false` is refused on a public route even then. Code's own database and files are no app data.
 */
export async function checkCodeRouteReads(input: {
  reads: readonly CodeRouteRead[];
  route: Pick<CodeRoute, "public" | "audience">;
  /** The signed-in visitor of a route that is not public; `null` on a public route. */
  visitor: RequestAuthority | null;
  /**
   * The version reads app data and has its own database (manifest `database` and policy row `read`), so its database
   * may hold app data it copied earlier: a public route that reads the database then needs owner-data too.
   */
  databaseMayHoldAppData: boolean;
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
  if (input.route.public) {
    const apps = new Set(
      input.reads.flatMap((read) => (read.kind === "query" && !isUnnamedRead(read.capability) ? [appOf(read.capability)] : [])),
    );
    for (const appId of apps) if (!(await factsOf(appId)).publicRoutes) return "forbidden";
    const ownerData =
      apps.size > 0 ||
      input.reads.some((read) => read.kind === "target") ||
      (input.databaseMayHoldAppData && input.reads.some((read) => read.kind === "query" && read.capability === "db.query"));
    return !ownerData || input.route.audience === "owner-data" ? "deliver" : "forbidden";
  }
  const resources = new Map<string, { type: string; id: string }>();
  const add = (ref: { type: string; id: string }) => resources.set(JSON.stringify([ref.type, ref.id]), ref);
  for (const read of input.reads) {
    if (read.kind === "target") add(read.ref);
    if (read.kind !== "input") continue;
    // A type reader's `id` and declared `inputRefs` name the resources an app-wide Query read. Other input names no
    // resource; the route's handler checks such data (09.11.).
    const named = (await factsOf(appOf(read.capability))).inputRefs[read.capability] ?? {};
    for (const [field, type] of Object.entries(named)) {
      const id = read.fields[field];
      if (id === undefined) continue;
      // An empty or over-long value cannot be checked (the reads cut strings past the longest resource ID).
      if (id.length === 0 || id.length > CLOUD_RESOURCE_ID_MAX_LENGTH) return "forbidden";
      add({ type, id });
    }
  }
  if (resources.size === 0) return "deliver";
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
