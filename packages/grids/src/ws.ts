import { rateLimit } from "@k2b/cloud/server";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";

/**
 * The socket of Grids tabs opened before live updates moved to `/live`. Such
 * a tab shows that live updates stopped and offers a reload, which then uses
 * the new socket. Remove it in the release after the one that added `/live`.
 */
export default new Hono().get(
  "/",
  rateLimit({ keyBy: "ip", limitPerSecond: 5 }),
  // Answers at once, so a socket that never subscribes holds nothing open.
  upgradeWebSocket(() => ({
    onOpen: (_event, ws) => ws.close(1008, "reload_required"),
  })),
);
