import { env } from "../../config/env";
import { publicCloudOrigin } from "../../shared/app-url";
import { get } from "../settings";

export const coreOrigin = async (internal = false): Promise<string> => {
  const configured = env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (internal && !configured) throw new Error("CLOUD_CORE_INTERNAL_ORIGIN is required for internal Core requests");
  const origin = configured || publicCloudOrigin(await get<string>("app.url"));
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("CLOUD_CORE_INTERNAL_ORIGIN must use http or https");
  return url.origin;
};
