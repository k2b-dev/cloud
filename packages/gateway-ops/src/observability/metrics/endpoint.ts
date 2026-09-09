import type { AuthContext } from "@k2b/cloud/server";
import type { Context } from "hono";
import { canReadMetrics, getMetricsSnapshot } from "./service";

export const metricsEndpoint = async (c: Context<AuthContext>): Promise<Response> => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  if (!actor) return c.text("Authentication required\n", 401);
  if (!canReadMetrics(actor)) return c.text("Insufficient permissions\n", 403);

  const snapshot = await getMetricsSnapshot();
  c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(snapshot.text);
};
