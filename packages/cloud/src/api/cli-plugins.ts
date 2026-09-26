import { Hono } from "hono";
import { requireCliPluginAccess } from "../_internal/cli-plugins";
import { listApps } from "../_internal/registry";
import type { CloudCliPluginSummary } from "../cli/plugin";
import type { AuthContext } from "../server/middleware/auth";

/**
 * `GET /cli/plugins`: the `cld` plugins that live applications serve, under
 * the same access rule as the plugin downloads. Core mounts this list; each
 * application serves its own plugin files.
 */
export const cliPluginListRoutes = new Hono<AuthContext>().get("/", requireCliPluginAccess, async (c) => {
  const plugins: CloudCliPluginSummary[] = (await listApps())
    .flatMap((app) => (app.cliModules ?? []).map((name) => ({ name, app: app.id, version: app.runtime?.version ?? "unknown" })))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return c.json({ plugins }, 200, { "cache-control": "private, no-store" });
});
