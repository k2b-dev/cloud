import { z } from "zod";
import { canonicalRoute } from "../_internal/app-path";
import { readBoundedJson } from "../_internal/bounded-json";
import { resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { getCapability, listApps, listCapabilities } from "../_internal/registry";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  CapabilitySemanticLinkSchema,
  type CloudResourceRef,
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import { parseCloudResourceUrl } from "../contracts/resource-clipboard";
import { localCloudResourceUrl, matchCloudResourcePage } from "../contracts/resource-pages";
import type { ResolvedCloudResourceUrl } from "../contracts/resource-resolution";
import type { RequestAuthority } from "../server";
import * as settings from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import { dispatchCapability } from "./capabilities";

const readCloudResourceLink = async (
  params: { ref: CloudResourceRef; request: Request; authority: RequestAuthority; locale?: string },
  dependencies: { getCapability?: typeof getCapability; dispatch?: typeof dispatchCapability } = {},
): Promise<ResolvedCloudResourceUrl | null> => {
  const parsed = CloudResourceRefSchema.safeParse(params.ref);
  if (!parsed.success) return null;
  const ref = parsed.data;
  const appId = cloudResourceRefAppId(ref);
  const app = await (dependencies.getCapability ?? getCapability)(appId);
  if (!app || app.appId !== appId) return null;
  const manifest = params.locale ? resolveCapabilityManifestPresentation(app.manifest, app.presentation, params.locale) : app.manifest;
  const reader = resolveCapabilityResourceReader(manifest, ref);
  if (!reader) return null;
  const response = await (dependencies.dispatch ?? dispatchCapability)({
    request: params.request,
    authority: params.authority,
    locale: params.locale,
    origin: "http",
    kind: "queries",
    appId,
    capabilityId: reader.localId,
    input: { id: ref.id },
  });
  if (!response.ok) return null;
  const body = await readBoundedJson(response, CAPABILITY_MAX_RESULT_BYTES, params.request.signal);
  if (!body.ok) return null;
  const result = capabilityResultSchema(z.unknown(), { consumer: true }).safeParse(body.data);
  if (!result.success) return null;
  const link = CapabilitySemanticLinkSchema.safeParse(
    result.data.links?.find((link) => link.rel === "open") ?? result.data.links?.find((link) => link.rel === "edit"),
  );
  if (!link.success) return null;
  const type = manifest.types.find((type) => `${appId}.${type.localId}` === ref.type);
  if (!type) return null;
  const reference = result.data.refs?.find((entry) => entry.type === ref.type && entry.id === ref.id);
  const icon = reference?.icon ?? type.icon;
  return { ref, title: reference?.title ?? type.title, ...(icon ? { icon } : {}), href: link.data.href };
};

/** Resolve a known reference through its authorized reader. */
export const resolveCloudResourceHref = async (
  params: Parameters<typeof readCloudResourceLink>[0],
  dependencies: Parameters<typeof readCloudResourceLink>[1] = {},
): Promise<string | null> => (await readCloudResourceLink(params, dependencies))?.href ?? null;

/** Recognize one local URL, then read the resource under the caller's authority. All failures are opaque. */
export const resolveCloudResourceUrl = async (
  params: { url: string; request: Request; authority: RequestAuthority; locale?: string },
  dependencies: Parameters<typeof readCloudResourceLink>[1] & {
    appUrl?: () => Promise<string | null | undefined>;
    listApps?: typeof listApps;
    listCapabilities?: typeof listCapabilities;
  } = {},
): Promise<ResolvedCloudResourceUrl | null> => {
  try {
    const configured = await (dependencies.appUrl ?? (() => settings.get<string>("app.url")))();
    const origin = configured ? publicCloudOrigin(configured) : null;
    const url = localCloudResourceUrl(params.url, origin);
    if (!url) return null;
    // Permalinks share the existing parser; fragments and incidental query parameters do not change identity.
    let ref = parseCloudResourceUrl(`${url.pathname}`, origin ?? url.origin);
    if (!ref && !url.pathname.startsWith("/open/")) {
      const apps = await (dependencies.listApps ?? listApps)();
      // Honor a more specific live owner, including apps that publish no resource pages.
      // A root or ancestor route must not capture their links. Equal prefix claims fail closed.
      const pathname = canonicalRoute(url.pathname);
      const namespace = pathname.split("/");
      const routes = apps.flatMap((app) =>
        app.routes.flatMap((route) => {
          const prefix = canonicalRoute(route);
          if (!prefix.startsWith("/") || /[%\\?#\s]/.test(prefix) || prefix.split("/").some((part) => part === "." || part === ".."))
            return [];
          if (namespace[1] === "app" && namespace[2] && namespace[2] !== app.id) return [];
          return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`)
            ? [{ appId: app.id, length: prefix.length }]
            : [];
        }),
      );
      const longest = routes.reduce((length, route) => Math.max(length, route.length), 0);
      const owners = new Set(routes.filter((route) => route.length === longest).map((route) => route.appId));
      if (owners.size !== 1) return null;
      const catalog = await (dependencies.listCapabilities ?? listCapabilities)(apps);
      const pages = catalog.flatMap((entry) => {
        const app = apps.find((app) => app.id === entry.appId);
        if (!app || !owners.has(app.id) || entry.manifest.appId !== app.id) return [];
        return (entry.manifest.resourcePages ?? []).flatMap((page) => {
          const ref = { type: `${app.id}.${page.type}`, id: "candidate" };
          return resolveCapabilityResourceReader(entry.manifest, ref) ? [{ type: ref.type, path: page.path, prefixes: app.routes }] : [];
        });
      });
      ref = matchCloudResourcePage(`${url.pathname}${url.search}`, pages);
    }
    return ref ? await readCloudResourceLink({ ...params, ref }, dependencies) : null;
  } catch {
    // Never include a pasted URL, resource existence, or provider error in this result.
    return null;
  }
};
