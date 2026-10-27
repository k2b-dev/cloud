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
