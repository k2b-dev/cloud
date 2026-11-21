import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { type CloudResourceRef, cloudResourceRefAppId, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { z } from "zod";
import type { CodePlace, CodeQueryInvoke } from "./code-summary";

const ReaderViewSchema = z.object({ view: z.object({ title: z.string().min(1) }) });

/**
 * Reads a place the way the person may see it, through its own app's public reader. Every failure leaves the place
 * unnamed rather than failing the page. The catalog read is shared per app within one request.
 */
export const loadCodePlace = async (
  ref: CloudResourceRef,
  invoke: CodeQueryInvoke,
  catalog: (appId: string) => ReturnType<typeof getCapabilityCatalogApp>,
): Promise<CodePlace> => {
  try {
    const app = await catalog(cloudResourceRefAppId(ref));
    if (!app.ok || !app.data) return {};
    const localType = ref.type.slice(app.data.appId.length + 1);
    const place: CodePlace = {
      type: app.data.manifest.types.find((type) => type.localId === localType)?.title ?? app.data.appName,
      canOwnCode: app.data.manifest.code?.owners.includes(localType) ?? false,
    };
    const reader = resolveCapabilityResourceReader(app.data.manifest, ref);
    if (!reader) return place;
    const read = await invoke({ appId: app.data.appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id } }, z.unknown());
    if (!read.ok) return place;
    return {
      ...place,
      name: ReaderViewSchema.safeParse(read.data.data).data?.view.title,
      href: read.data.links?.find((link) => link.rel === "open")?.href,
    };
  } catch {
    return {};
  }
};

/** One catalog read per app and request. */
export const catalogPerApp = (locale: string, authority: Parameters<typeof getCapabilityCatalogApp>[2]) => {
  const apps = new Map<string, ReturnType<typeof getCapabilityCatalogApp>>();
  return (appId: string) => {
    let app = apps.get(appId);
    if (!app) {
      app = getCapabilityCatalogApp(appId, locale, authority);
      apps.set(appId, app);
    }
    return app;
  };
};
