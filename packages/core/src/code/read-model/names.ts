import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceReaderViewSchema, type CodeCheckedVersionManifest, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { z } from "zod";
import type { CodeContext } from "../access";
import { codeReadModelMessages } from "./messages";
import type { ReadModelNames, ReadModelTarget } from "./present";

const keyOf = (ref: { type: string; id: string | null }) => JSON.stringify([ref.type, ref.id]);
const ReaderSchema = z.object({ view: CloudResourceReaderViewSchema });

/** Reader answers, not admin status or registry page patterns, authorize both names and open links. */
export async function readModelNames(
  manifests: readonly CodeCheckedVersionManifest[],
  context: CodeContext,
  operationIds: readonly string[] = [],
  targetsToRead: readonly { type: string; id: string | null }[] = [],
): Promise<ReadModelNames> {
  const { t, locale } = codeReadModelMessages.resolve(context.locale ? [context.locale] : []);
  const catalogs = new Map<string, Promise<Awaited<ReturnType<typeof getCapabilityCatalogApp>> | null>>();
  const catalog = (appId: string) => {
    let pending = catalogs.get(appId);
    if (!pending) {
      pending = getCapabilityCatalogApp(appId, locale, context.authority).catch(() => {
        context.signal?.throwIfAborted();
        return null;
      });
      catalogs.set(appId, pending);
    }
    return pending;
  };
  const targets = new Map<string, ReadModelTarget>();
  const operations = new Map<string, { title: string; app?: string; icon?: string }>();
  const events = new Map<string, string>();
  const refs = new Map<string, { type: string; id: string | null }>();
  for (const manifest of manifests) {
    for (const permission of manifest.permissions) {
      const ref = permission.target ?? { type: "app", id: permission.operation.split(".")[0]! };
      refs.set(keyOf(ref), ref);
      await catalog(permission.operation.split(".")[0]!);
    }
    for (const entry of manifest.entrypoints) if (entry.event) refs.set(keyOf(entry.event.place), entry.event.place);
  }
  for (const ref of targetsToRead) refs.set(keyOf(ref), ref);
  for (const operation of operationIds) await catalog(operation.split(".")[0]!);
  const resolve = async (ref: { type: string; id: string | null }) => {
    context.signal?.throwIfAborted();
    const appId = ref.type === "app" ? ref.id : ref.type.split(".")[0];
    if (!appId) return;
    const loaded = await catalog(appId);
    const data = loaded?.ok ? loaded.data : null;
    const local = ref.type.slice(appId.length + 1);
    const type = data?.manifest.types.find((item) => item.localId === local)?.title ?? t.target;
    const base = { name: ref.id === null ? t.dynamic({ type }) : t.hidden({ type }), readable: false };
    targets.set(keyOf(ref), base);
    if (!data || ref.id === null) return;
    if (ref.type === "app") {
      targets.set(keyOf(ref), { name: data.appName, readable: true });
      return;
    }
    const reader = resolveCapabilityResourceReader(data.manifest, { type: ref.type, id: ref.id });
    if (!reader) return;
    const result =
      context.authority.credentialKind === "invocation" && context.query
        ? await context.query({ appId, capabilityId: reader.localId, input: { id: ref.id }, signal: context.signal }, ReaderSchema)
        : await invokeCapabilityWithDataSchema(
            { appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id } },
            ReaderSchema,
            { authority: context.authority, locale, signal: context.signal },
          );
    if (!result.ok) return;
    const href = result.data.links?.find((link) => link.rel === "open")?.href;
    targets.set(keyOf(ref), { name: result.data.data.view.title, readable: true, ...(href ? { href } : {}) });
  };
  // Reuse the page's bounded provider concurrency; a manifest never fans out one promise per target at once.
  const entries = [...refs.values()];
  for (let offset = 0; offset < entries.length; offset += 8) {
    const results = await Promise.allSettled(entries.slice(offset, offset + 8).map(resolve));
    for (const result of results) if (result.status === "rejected") context.signal?.throwIfAborted();
  }
  for (const [appId, pending] of catalogs) {
    const result = await pending;
    if (!result?.ok || !result.data) continue;
    const data = result.data;
    for (const operation of [...data.manifest.queries, ...data.manifest.actions])
      operations.set(`${appId}.${operation.localId}`, {
        title: operation.title,
        app: data.appName,
        ...(data.appIcon ? { icon: data.appIcon } : {}),
      });
    for (const event of data.manifest.events ?? []) events.set(`${appId}.${event.localId}`, event.title);
  }
  return {
    target: (ref) => targets.get(keyOf(ref)) ?? { name: t.hidden({ type: t.target }), readable: false },
    operation: (id) => operations.get(id) ?? { title: t.action },
    event: (id) => events.get(id) ?? t.event,
  };
}
