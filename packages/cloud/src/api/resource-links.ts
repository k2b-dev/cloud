import { z } from "zod";
import { getCapability } from "../_internal/registry";
import {
  CapabilitySemanticLinkSchema,
  type CloudResourceRef,
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { dispatchCapability } from "./capabilities";

export const resolveCloudResourceHref = async (
  params: { ref: CloudResourceRef; request: Request; authority: RequestAuthority; locale?: string },
  dependencies: { getCapability?: typeof getCapability; dispatch?: typeof dispatchCapability } = {},
): Promise<string | null> => {
  const parsed = CloudResourceRefSchema.safeParse(params.ref);
  if (!parsed.success) return null;
  const ref = parsed.data;
  const appId = cloudResourceRefAppId(ref);
  const app = await (dependencies.getCapability ?? getCapability)(appId);
  if (!app || app.appId !== appId) return null;
  const reader = resolveCapabilityResourceReader(app.manifest, ref);
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
  const result = capabilityResultSchema(z.unknown(), { consumer: true }).safeParse(await response.json());
  if (!result.success) return null;
  const link = CapabilitySemanticLinkSchema.safeParse(
    result.data.links?.find((link) => link.rel === "open") ?? result.data.links?.find((link) => link.rel === "edit"),
  );
  return link.success ? link.data.href : null;
};
