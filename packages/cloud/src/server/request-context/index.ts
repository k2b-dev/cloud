import type { Context } from "hono";
import { clientIp } from "../client-ip";
import { getLocale } from "../locale";
import { publicClientAddress } from "./address";
import { type GeoIp, getGeoIp } from "./geoip";
import { type BrowserCode, describeBrowser, type OsCode } from "./user-agent";

export { clientIp } from "../client-ip";
export { addressPrefix, publicClientAddress } from "./address";
export {
  BUNDLED_GEOIP_PATHS,
  createGeoIp,
  DBIP_ATTRIBUTION,
  type GeoIp,
  type GeoIpDatabaseInfo,
  type GeoIpLookup,
  getGeoIp,
  openGeoIpDatabase,
  truncateUtf8,
} from "./geoip";
export { type BrowserCode, describeBrowser, type OsCode } from "./user-agent";

export const describeRequest = (c: Context, options?: { locale?: string; geoIp?: GeoIp }) => {
  let browser: { browser: BrowserCode; os: OsCode } = { browser: "other", os: "other" };
  try {
    browser = describeBrowser(c.req.raw.headers);
    return { ...browser, ...(options?.geoIp ?? getGeoIp()).lookup(publicClientAddress(clientIp(c)), options?.locale ?? getLocale(c)) };
  } catch {
    return { ...browser, cityDatabase: false, asnDatabase: false, country: null, city: null, network: null };
  }
};
