import { type GridsAccessContext, gateCustomAppAtAccess } from "../../api/permissions";
import { resolveCustomAppPage } from "../../custom-apps/routing";
import { gridsService } from "../../service";

/** Only the HTML entry point redirects. API failures keep their normal status. */
export async function customAppPageNeedsLogin(access: GridsAccessContext, shortId: string, pageId?: string): Promise<boolean> {
  if (access.actor) return false;
  const app = await gridsService.customApp.getPublishedByShortId(shortId);
  if (!app?.publishedAt || !app.publishedDefinition || !app.publishedCapabilities) return false;
  if (!resolveCustomAppPage(app.publishedDefinition, pageId)) return false;
  return !(await gateCustomAppAtAccess(access, app.id)).ok;
}
