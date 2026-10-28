import { websocket } from "hono/bun";
import apiRoutes from "./api";
import { chatCapabilities } from "./capabilities";
import { app } from "./config";
import { chatHelp } from "./help";
import { migrate } from "./migrate";
import { router } from "./router";
import { chatService } from "./service";
import { maintenanceLifecycle } from "./service/maintenance";

const result = await app.start({
  capabilities: chatCapabilities,
  fetch: router.fetch,
  help: chatHelp,
  openapi: apiRoutes,
  lifecycle: {
    ...maintenanceLifecycle,
    setup: async () => {
      await migrate();
    },
  },
});
// `/api/chat/live` upgrades through Bun, which needs the WebSocket handlers on the server definition.
export default { ...result, websocket };
export type { ApiType } from "./api";
export type { ChatHealth, ChatService } from "./service";
export { chatService as service };
