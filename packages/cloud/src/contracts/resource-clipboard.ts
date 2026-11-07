import { z } from "zod";
import { type CloudResourceRef, CloudResourceRefSchema } from "./capabilities";
import { cloudResourceHref } from "./resource-href";

export const CLOUD_RESOURCE_CLIPBOARD_MIME_TYPE = "application/vnd.k2b.cloud-resource-ref+json";
export const CLOUD_RESOURCE_CLIPBOARD_WEB_FORMAT = `web ${CLOUD_RESOURCE_CLIPBOARD_MIME_TYPE}`;
export const CLOUD_RESOURCE_CLIPBOARD_MAX_BYTES = 4_096;

export const CloudResourceClipboardPayloadSchema = z
  .object({
    version: z.literal(1),
    cloudUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === value, "Expected the canonical Cloud origin"),
    ref: CloudResourceRefSchema,
  })
  .strict();

export type CloudResourceClipboardPayload = z.infer<typeof CloudResourceClipboardPayloadSchema>;

export const serializeCloudResourceClipboard = (input: { cloudUrl: string; ref: CloudResourceRef }): string =>
  JSON.stringify(CloudResourceClipboardPayloadSchema.parse({ version: 1, ...input }));

export const parseCloudResourceClipboard = (value: string, cloudUrl: string): CloudResourceRef | null => {
  if (new TextEncoder().encode(value).byteLength > CLOUD_RESOURCE_CLIPBOARD_MAX_BYTES) return null;

  try {
    const payload = CloudResourceClipboardPayloadSchema.safeParse(JSON.parse(value));
    return payload.success && payload.data.cloudUrl === cloudUrl ? payload.data.ref : null;
  } catch {
    return null;
  }
};

/** Longest permalink a consumer accepts, like `CloudResourceHrefSchema`. */
const CLOUD_RESOURCE_URL_MAX_LENGTH = 8_192;
const CLOUD_RESOURCE_PATH = /^\/open\/([^/]+)\/~([^/]+)$/;

/** The absolute permalink of a resource: the text form people copy, paste, and open. */
export const formatCloudResourceUrl = (ref: CloudResourceRef, cloudUrl: string): string =>
  new URL(cloudResourceHref(CloudResourceRefSchema.parse(ref)), cloudUrl).href;

/**
 * Reads a resource from its permalink on this Cloud, absolute or root-relative. Anything else, such as another
 * installation's link, an app page, or a query or fragment, returns `null`.
 */
export const parseCloudResourceUrl = (value: string, cloudUrl: string): CloudResourceRef | null => {
  const text = value.trim();
  if (text.length === 0 || text.length > CLOUD_RESOURCE_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = text.startsWith("/") && !text.startsWith("//") ? new URL(text, cloudUrl) : new URL(text);
  } catch {
    return null;
  }
  if (url.origin !== cloudUrl || url.search || url.hash) return null;
  const match = CLOUD_RESOURCE_PATH.exec(url.pathname);
  if (!match?.[1] || !match[2]) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const ref = CloudResourceRefSchema.safeParse({ type: match[1], id });
  return ref.success ? ref.data : null;
};
