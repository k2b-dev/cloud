import { type CapabilityCaller, getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@valentinkolb/cloud/capabilities/server";
import {
  type CapabilityManifest,
  type CapabilitySemanticLink,
  type CloudResourceReference,
  type CloudResourceView,
  CloudResourceViewSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import type { SpaceItemResourceReference } from "@/contracts";

export type ItemResourceReferenceView = SpaceItemResourceReference & { resource: CloudResourceView | null };

const READER_CONCURRENCY = 8;

type ResourceReaderDependencies = {
  getCatalogApp: (appId: string) => Promise<{ appId: string; manifest: CapabilityManifest } | null>;
  invokeReader: (
    input: { appId: string; capabilityId: string; id: string },
    caller: CapabilityCaller,
  ) => Promise<{ refs: CloudResourceReference[]; links: CapabilitySemanticLink[] } | null>;
};

const resourceReaderDependencies: ResourceReaderDependencies = {
  getCatalogApp: async (appId) => {
    const result = await getCapabilityCatalogApp(appId);
    return result.ok ? result.data : null;
  },
  invokeReader: async ({ appId, capabilityId, id }, caller) => {
    const result = await invokeCapabilityWithDataSchema({ appId, capabilityId, kind: "query", input: { id } }, z.unknown(), caller);
    return result.ok && result.data.links?.length ? { refs: result.data.refs ?? [], links: result.data.links } : null;
  },
};

export const resolveReferenceViews = async (
  references: SpaceItemResourceReference[],
  caller: CapabilityCaller,
  dependencies: ResourceReaderDependencies = resourceReaderDependencies,
): Promise<ItemResourceReferenceView[]> => {
  const catalogs = new Map<string, Promise<{ appId: string; manifest: CapabilityManifest } | null>>();
  const resolveOne = async (reference: SpaceItemResourceReference): Promise<ItemResourceReferenceView> => {
    const appId = cloudResourceRefAppId(reference.ref);
    let catalog = catalogs.get(appId);
    if (!catalog) {
      catalog = dependencies.getCatalogApp(appId);
      catalogs.set(appId, catalog);
    }
    const app = await catalog;
    const reader = app ? resolveCapabilityResourceReader(app.manifest, reference.ref) : null;
    if (!reader) return { ...reference, resource: null };
    const result = await dependencies.invokeReader({ appId, capabilityId: reader.localId, id: reference.ref.id }, caller);
    if (!result) return { ...reference, resource: null };
    const localType = reference.ref.type.slice(appId.length + 1);
    const type = app?.manifest.types.find((candidate) => candidate.localId === localType);
    const current = result.refs.find((candidate) => candidate.type === reference.ref.type && candidate.id === reference.ref.id);
    const icon = current?.icon ?? type?.icon;
    const resource = CloudResourceViewSchema.parse({
      ref: reference.ref,
      title: current?.title ?? reference.label,
      ...(current?.preview ? { preview: current.preview } : {}),
      ...(icon ? { icon } : {}),
      links: result.links,
    });
    return { ...reference, resource };
  };

  const views: ItemResourceReferenceView[] = [];
  for (let offset = 0; offset < references.length; offset += READER_CONCURRENCY) {
    views.push(...(await Promise.all(references.slice(offset, offset + READER_CONCURRENCY).map(resolveOne))));
  }
  return views;
};
