import type { Context } from "hono";
import { maskShareAccessNetwork, type ShareAccessClient, type ShareAccessContext } from "../data/share-access";

/** Only a fixed family leaves this function; headers and version strings are discarded. */
function client(headers: Headers): ShareAccessClient {
  const agent = (headers.get("user-agent") ?? "").slice(0, 512);
  const brands = (headers.get("sec-ch-ua") ?? "").slice(0, 256);
  if (/\b(?:Edg|EdgA|EdgiOS|Edge)\//.test(agent) || /"Microsoft Edge";/.test(brands)) return "edge";
  if (/\b(?:OPR|Opera)\//.test(agent) || /"Opera(?: GX)?";/.test(brands)) return "opera";
  if (/\bSamsungBrowser\//.test(agent) || /"Samsung Internet";/.test(brands)) return "samsung";
  if (/\b(?:Firefox|FxiOS)\//.test(agent)) return "firefox";
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(agent) || /"(?:Google Chrome|Chromium)";/.test(brands)) return "chrome";
  if (/\bSafari\//.test(agent)) return "safari";
  return "other";
}

/** The gateway owns forwarding headers, as on Files' public upload rate-limit path. */
export function shareAccessContext(c: Context): ShareAccessContext {
  const address = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip");
  return { network: maskShareAccessNetwork(address), client: client(c.req.raw.headers) };
}
