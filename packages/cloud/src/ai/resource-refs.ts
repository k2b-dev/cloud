import {
  CloudResourceHrefSchema,
  type CloudResourceRef,
  CloudResourceReferenceSchema,
  type CloudResourceView,
  CloudResourceViewSchema,
  cloudResourceHref,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { AiConversationResourceObservation } from "./types";

const LinkedResourceReferenceSchema = CloudResourceReferenceSchema.extend({
  href: CloudResourceHrefSchema.optional(),
});

export const addCloudResourceHrefs = <T>(
  value: T,
  apps: readonly Pick<CapabilityRegistryEntry, "appId" | "manifest">[],
  origin?: string,
) => {
  if (!value || typeof value !== "object" || !("refs" in value) || !Array.isArray(value.refs)) return value;
  return {
    ...value,
    refs: value.refs.map((reference: unknown) => {
      if (reference && typeof reference === "object" && "href" in reference) return reference;
      const parsed = CloudResourceReferenceSchema.safeParse(reference);
      if (!parsed.success) return reference;
      const ref = parsed.data;
      if (!ref.id.isWellFormed()) return reference;
      const app = apps.find((candidate) => candidate.appId === cloudResourceRefAppId(ref));
      if (!app || !resolveCapabilityResourceReader(app.manifest, ref)) return reference;
      const href = CloudResourceHrefSchema.safeParse(cloudResourceHref(ref));
      if (!href.success) return reference;
      return { ...ref, href: origin ? new URL(href.data, origin).href : href.data };
    }),
  };
};

const observationKey = (ref: CloudResourceRef): string => `${ref.type}\0${ref.id}`;

export const isConversationResourceCursor = (value: string, scope: "conversation" | "user"): boolean => {
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
    return (
      typeof parsed.at === "string" &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.type === "string" &&
      parsed.type.length > 0 &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      (scope === "user" ? typeof parsed.chat === "string" && parsed.chat.length > 0 : parsed.chat === undefined)
    );
  } catch {
    return false;
  }
};

/** Collect only schema-valid structured refs; never infer identities from text. */
export const collectConversationResourceObservations = (...values: unknown[]): AiConversationResourceObservation[] => {
  const observations = new Map<string, AiConversationResourceObservation>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const view = CloudResourceViewSchema.safeParse(value);
    if (view.success) {
      const resource: CloudResourceView = view.data;
      observations.set(observationKey(resource.ref), {
        ref: resource.ref,
        title: resource.title,
        preview: resource.preview,
        icon: resource.icon,
        href: resource.links.find((link) => link.rel === "open")?.href,
      });
    } else {
      const reference = LinkedResourceReferenceSchema.safeParse(value);
      if (reference.success) {
        const resource = reference.data;
        const ref: CloudResourceRef = { type: resource.type, id: resource.id };
        const previous = observations.get(observationKey(ref));
        observations.set(observationKey(ref), {
          ...previous,
          ref,
          ...(resource.title !== undefined ? { title: resource.title } : {}),
          ...(resource.preview !== undefined ? { preview: resource.preview } : {}),
          ...(resource.icon !== undefined ? { icon: resource.icon } : {}),
          ...(resource.href !== undefined ? { href: resource.href } : {}),
        });
      }
    }

    for (const nested of Object.values(value as Record<string, unknown>)) visit(nested);
  };

  for (const value of values) visit(value);
  return [...observations.values()];
};
