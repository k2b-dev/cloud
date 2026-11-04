import { z } from "zod";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "../capabilities/server";
import {
  CloudResourceReaderViewSchema,
  type CloudResourceRef,
  cloudResourceRefAppId,
  resolveCapabilityResourceReader,
} from "../contracts/capabilities";
import type { RequestAuthority } from "../server";

/** Generic target search admission. The target's own reader checks its local current grants.
 * No owner-title read occurs: the requested target, never the Code owner, supplies Manage.
 */
export const managesPrincipalSearchTarget = async (
  target: CloudResourceRef,
  authority: RequestAuthority,
  locale?: string,
  signal?: AbortSignal,
) => {
  try {
    const appId = cloudResourceRefAppId(target);
    const catalog = await getCapabilityCatalogApp(appId, locale, authority);
    if (!catalog.ok || !catalog.data) return false;
    const reader = resolveCapabilityResourceReader(catalog.data.manifest, target);
    if (!reader) return false;
    const result = await invokeCapabilityWithDataSchema(
      { appId, capabilityId: reader.localId, kind: "query", input: { id: target.id } },
      z.object({ view: CloudResourceReaderViewSchema }),
      { authority, locale, signal },
    );
    return result.ok && result.data.data.view.permission === "admin";
  } catch {
    return false;
  }
};
