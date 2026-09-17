import type { SearchItem } from "../api/search/schemas";
import type { CloudResourceRef } from "../contracts";

const PROVIDER_LIMIT = 10;
const refKey = (ref: CloudResourceRef) => `${ref.type}\u0000${ref.id}`;

export const cloudResourceSearchUrl = (request: {
  query: string;
  tags: readonly string[];
  appId?: string | null;
  scope?: CloudResourceRef;
  scopeTag?: string;
  requireReader?: boolean;
}): string => {
  const params = new URLSearchParams({ provider_limit: String(PROVIDER_LIMIT) });
  if (request.query.length > 0) params.set("q", request.query);
  for (const tag of request.tags) params.append("tag", tag);
  if (request.appId) params.set("app", request.appId);
  if (request.scopeTag !== undefined) params.set("scope_tag", request.scopeTag);
  if (request.scope) {
    params.set("scope_type", request.scope.type);
    params.set("scope_id", request.scope.id);
  }
  if (request.requireReader) params.set("require_reader", "true");
  return `/api/search?${params.toString()}`;
};

export const filterCloudResourceSearchItems = (
  items: readonly SearchItem[],
  options: { excludeRefs?: readonly CloudResourceRef[]; requireReader?: boolean },
): SearchItem[] => {
  const excluded = new Set((options.excludeRefs ?? []).map(refKey));
  return items.filter((item) => (!options.requireReader || item.readable) && !excluded.has(refKey(item.ref)));
};
