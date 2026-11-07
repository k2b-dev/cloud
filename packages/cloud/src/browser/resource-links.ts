import type { CoreApiType } from "../api";
import { localCloudResourceUrl } from "../contracts/resource-pages";
import type { ResolvedCloudResourceUrl } from "../contracts/resource-resolution";
import { createApiClient } from "../server/api-client";
import { readShellData } from "../ssr/shell-data";

export type { ResolvedCloudResourceUrl } from "../contracts/resource-resolution";

/** Available on Layout and AdminLayout pages; MinimalLayout does not install shell data. */
export const cloudOrigin = (): string | null => readShellData()?.cloudOrigin ?? null;

/** Recognize one pasted Cloud link. Unsupported, unreadable, and unavailable links all return null. */
export const resolveCloudUrl = async (text: string, options: { signal?: AbortSignal } = {}): Promise<ResolvedCloudResourceUrl | null> => {
  const url = text.trim();
  if (!localCloudResourceUrl(url, cloudOrigin())) return null;
  try {
    const response = await createApiClient<CoreApiType>().resources.resolve.$post({ json: { url } }, { init: { signal: options.signal } });
    if (!response.ok) return null;
    // Validate only after a successful response; Zod stays out of the initial browser graph.
    const { ResolvedCloudResourceUrlSchema } = await import("../contracts/resource-resolution");
    const result = ResolvedCloudResourceUrlSchema.safeParse(await response.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

// Ctrl+Shift+V (Cmd+Shift+V, also with Option, which changes the key's character) asks for plain text; that paste
// keeps the link as it is.
let plainPasteAt = -Infinity;
if (typeof window !== "undefined")
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.shiftKey && (event.ctrlKey || event.metaKey) && (event.code === "KeyV" || event.key.toLowerCase() === "v"))
        plainPasteAt = event.timeStamp;
    },
    true,
  );

/**
 * The Cloud link a paste carries: one absolute URL on this Cloud, as copied from the address bar or "Copy Cloud ID",
 * and nothing else. Returns null for other text, other origins, and a paste as plain text. Recognize the link with
 * `resolveCloudUrl()`.
 */
export const pastedCloudLink = (event: ClipboardEvent): string | null => {
  const plain = event.timeStamp - plainPasteAt < 1_000;
  plainPasteAt = -Infinity;
  const text = (event.clipboardData?.getData("text/plain") ?? "").trim();
  if (plain || text.startsWith("/")) return null;
  return localCloudResourceUrl(text, cloudOrigin()) ? text : null;
};
