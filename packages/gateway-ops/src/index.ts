import { apiRoutes } from "./api";
import { gatewayOpsCapabilities } from "./capabilities";
import { app } from "./config";
import { webhookAllowlist } from "./health-webhooks";
import { gatewayOpsHelp } from "./help";
import { gatewayOpsLifecycle } from "./lifecycle";
import { loggingErrorsWidgetHandler } from "./observability/logs/widgets";
import { router } from "./router";
import { gatewayHealthWidgetHandler } from "./widgets";

export default await app.start({
  fetch: router.fetch,
  capabilities: gatewayOpsCapabilities,
  help: gatewayOpsHelp,
  openapi: apiRoutes,
  widgets: { health: gatewayHealthWidgetHandler, errors: loggingErrorsWidgetHandler },
  lifecycle: {
    ...gatewayOpsLifecycle,
    start: async (context) => {
      await webhookAllowlist();
      await gatewayOpsLifecycle.start?.(context);
    },
  },
});

export type { ApiType } from "./api";
