import type { RuntimeAppMeta } from "@k2b/cloud/contracts";
import { hasDedicatedRuntimeRoute } from "@k2b/cloud/ssr/app-navigation";

/**
 * `/admin` has no page of its own: it opens the operations overview where an app serves it (Gateway Ops), otherwise
 * the Apps page. An old link keeps its parameters.
 */
export const adminStart = (apps: readonly RuntimeAppMeta[], url: string) =>
  `${hasDedicatedRuntimeRoute(apps, "/admin/observability", "core") ? "/admin/observability" : "/admin/apps"}${new URL(url).search}`;
