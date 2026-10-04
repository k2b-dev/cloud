import { createHash } from "node:crypto";
import { CLOUD_LOGO_SVG } from "../../shared/branding";
import * as settings from "../settings";

/** Bumped when the drawing changes, so installed apps pick up the new icons. */
const RENDERER_VERSION = "1";
/** Larger logos fall back to the Cloud logo instead of reaching the decoder. */
export const APP_ICON_SOURCE_MAX_BYTES = 10 * 1024 * 1024;

export type AppIconSource = { data: Uint8Array; mime: string; version: string };

const DATA_URI = /^data:([^;,]+);base64,(.+)$/;

let latest: { logo: string; source: AppIconSource } | undefined;

const parse = (logo: string): AppIconSource => {
  const match = DATA_URI.exec(logo);
  const data = match ? Buffer.from(match[2]!, "base64") : null;
  const source =
    match && data && data.byteLength > 0 && data.byteLength <= APP_ICON_SOURCE_MAX_BYTES
      ? { data: new Uint8Array(data), mime: match[1]!, key: logo }
      : { data: new TextEncoder().encode(CLOUD_LOGO_SVG), mime: "image/svg+xml", key: CLOUD_LOGO_SVG };
  const version = createHash("sha256").update(source.key).update(RENDERER_VERSION).digest("hex").slice(0, 12);
  return { data: source.data, mime: source.mime, version };
};

/**
 * The installation logo the app icons are drawn from: `app.logo` when it is a base64 data URI (as uploaded in the
 * settings), otherwise the Cloud logo. `version` is the first 12 hex characters of a hash over the logo and the
 * drawing, so it changes exactly when the icons do.
 */
export const readAppIconSource = async (): Promise<AppIconSource> => {
  const logo = (await settings.get<string>("app.logo")) || "";
  // The manifest, the worker and the icons read it on every request; decode and hash a logo only once.
  if (latest?.logo !== logo) latest = { logo, source: parse(logo) };
  return latest.source;
};

/** The icons' version; the app's manifest carries it, so a new logo reaches installed apps. */
export const appIconVersion = async (): Promise<string> => (await readAppIconSource()).version;
