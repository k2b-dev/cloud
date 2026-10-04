import { rateLimit } from "@k2b/cloud/server";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";

/**
 * The socket of Contacts tabs opened before live updates moved to `/live`.
 * It asks such a tab to load the page again, which then uses the new socket.
 * Remove it in the release after the one that added `/live`.
 */
export default new Hono().get(
  "/",
  rateLimit({ keyBy: "ip", limitPerSecond: 5 }),
  // Answers at once, so a socket that never subscribes holds nothing open.
  upgradeWebSocket(() => ({
    onOpen: (_event, ws) => {
      const payload = { code: "resync_required", message: "Contacts was updated. Reload the page." };
      ws.send(JSON.stringify({ type: "contacts.live.error", payload }));
      ws.close(1012, "resync_required");
    },
  })),
);
