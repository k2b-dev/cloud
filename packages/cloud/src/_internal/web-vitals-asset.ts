import { createHash } from "node:crypto";
import { dependencies } from "../../package.json";
import * as collectorModule from "../browser/web-vitals.ts" with { type: "text" };

// All apps using the same collector share one Core asset and browser cache key.
// Both inputs are bundled, so production servers need no source files on disk.
if (!("default" in collectorModule) || typeof collectorModule.default !== "string") throw new Error("Expected collector source text");
const version = createHash("sha256").update(collectorModule.default).update(dependencies["web-vitals"]).digest("hex").slice(0, 16);
export const WEB_VITALS_ASSET_NAME = `web-vitals-${version}.js`;
export const WEB_VITALS_ASSET_HREF = `/public/${WEB_VITALS_ASSET_NAME}`;
