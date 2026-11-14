import { getApp, listApps, sql } from "@k2b/cloud";
import { publicCloudOrigin } from "@k2b/cloud/api";
import { coreSettings } from "@k2b/cloud/services";

/** Include configured domains even when the owning application is offline. */
export async function readCodeOwnOrigins(): Promise<string[]> {
  const domains = await sql<{ host: string }[]>`SELECT host FROM settings.app_domains`;
  return [
    publicCloudOrigin(await coreSettings.get<string>("app.url")),
    (await getApp("core"))?.baseUrl ?? "http://app-core:3000",
    ...(await listApps()).map((app) => app.baseUrl),
    ...domains.map(({ host }) => `https://${host}`),
  ];
}
