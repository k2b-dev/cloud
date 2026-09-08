/**
 * `cld admin` — Cloud administration surfaces.
 *
 * Commands are grouped per domain in sibling modules; this file only composes
 * them. The groups map to the admin UI areas, so a command and the page that
 * shows the same data stay easy to find together.
 */
import { defineCliCommands } from "../commands";
import { accountAdministrationCommands } from "./account-administration";
import { accountCategoryCommands } from "./account-categories";
import { aiUsageCommands } from "./ai-usage";
import { dataCommands } from "./data";
import { gatewayCommands } from "./gateway";
import { instanceCommands } from "./instance";
import { jobCommands } from "./jobs";
import { legalCommands } from "./legal";
import { linuxCommands } from "./linux";
import { logCommands } from "./logs";
import { metricsCommands } from "./metrics";
import { natsCommands } from "./nats";
import { notificationCommands } from "./notifications";
import { syncCommands } from "./sync";
import { telemetryCommands } from "./telemetry";
import { webhookCommands } from "./webhooks";
import { workflowCommands } from "./workflows";

export default defineCliCommands({
  name: "admin",
  summary: "Inspect and operate Cloud administration surfaces.",
  groupSummaries: {
    "accounts config": "Manage account types and sign-in visibility.",
    "accounts administration": "Manage account requests and account/group follow-up notices.",
    legal: "Manage Terms, Privacy, and Imprint.",
    linux: "Prepare Linux identities.",
    "linux config": "Manage Linux identity defaults and allocation range.",
  },
  commands: [
    ...accountCategoryCommands,
    ...accountAdministrationCommands,
    ...aiUsageCommands,
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
    ...natsCommands,
    ...syncCommands,
  ],
});
