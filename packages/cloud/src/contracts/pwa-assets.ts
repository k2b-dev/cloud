/** Only public, versioned build output belongs in this catalog. Never pages or application data. */
export type PwaStaticAsset = {
  url: string;
  sha256: string;
  bytes: number;
  type: string;
};

export const PWA_ASSET_MANIFEST_PATH = "/_internal/pwa-assets";
/** 16 MiB: over twice the report's Start + Chat + Spaces JS and shared CSS (about 6 MiB). */
export const PWA_ASSET_CACHE_BYTES = 16 * 1024 * 1024;

export function isPwaStaticAsset(value: unknown): value is PwaStaticAsset {
  if (typeof value !== "object" || value === null) return false;
  if (!("url" in value) || !("sha256" in value) || !("bytes" in value) || !("type" in value)) return false;
  const asset = value;
  if (!validMetadata(asset) || typeof asset.url !== "string" || asset.url.startsWith("/api/")) return false;
  // Versioned SSR directories, versioned public stylesheets, or content-hashed public files only.
  const versioned =
    /^\/(?:[a-zA-Z0-9._~-]+\/)*_ssr\/[a-f0-9]{16}\/[a-z0-9._-]+\.js$/.test(asset.url) ||
    /^\/public\/(?:[a-zA-Z0-9._-]+\/)*(?:[a-zA-Z0-9._-]+\.css\?v=[a-zA-Z0-9._%-]+|[a-zA-Z0-9._-]*[a-f0-9]{16}(?:[a-f0-9]{48})?\.(?:js|css|woff2?))$/.test(
      asset.url,
    );
  if (!versioned) return false;
  const url = new URL(asset.url, "https://static.invalid");
  return url.pathname + url.search === asset.url;
}

function validMetadata(asset: Record<string, unknown>): boolean {
  return (
    typeof asset.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(asset.sha256) &&
    typeof asset.bytes === "number" &&
    Number.isSafeInteger(asset.bytes) &&
    asset.bytes > 0 &&
    asset.bytes <= PWA_ASSET_CACHE_BYTES &&
    typeof asset.type === "string" &&
    ["text/css", "text/javascript", "font/woff", "font/woff2"].includes(asset.type)
  );
}
