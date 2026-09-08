/**
 * `cld admin` — Cloud administration surfaces.
 *
 * Commands are grouped per domain in sibling modules; this file only composes
 * them. The groups map to the admin UI areas, so a command and the page that
 * shows the same data stay easy to find together.
 */
import { defineCliCommands } from "../commands";
import { dataCommands } from "./data";
import { gatewayCommands } from "./gateway";
import { instanceCommands } from "./instance";
import { jobCommands } from "./jobs";
import { legalCommands } from "./legal";
import { logCommands } from "./logs";
import { linuxCommands } from "./linux";
import { metricsCommands } from "./metrics";
import { notificationCommands } from "./notifications";
import { telemetryCommands } from "./telemetry";
import { webhookCommands } from "./webhooks";
import { workflowCommands } from "./workflows";

export default defineCliCommands({
  name: "admin",
  summary: "Inspect and operate Cloud administration surfaces.",
  groupSummaries: {
    legal: "Manage Terms, Privacy, and Imprint.",
    linux: "Prepare Linux identities.",
    "linux config": "Manage Linux identity defaults and allocation range.",
  },
  commands: [
    ...instanceCommands,
    ...gatewayCommands,
    ...logCommands,
    ...telemetryCommands,
    ...jobCommands,
    ...legalCommands,
    ...linuxCommands,
    ...workflowCommands,
    ...dataCommands,
    ...notificationCommands,
    ...webhookCommands,
    ...metricsCommands,
  ],
});
