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
import { aiQuotaCommands } from "./ai-quotas";
import { aiSkillCommands } from "./ai-skills";
import { aiUsageCommands } from "./ai-usage";
import { appCredentialCommands } from "./app-credentials";
import { appSignInCommands } from "./app-sign-in";
import { dataCommands } from "./data";
import { documentationCommands } from "./documentation";
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
    accounts: "Manage account policy and account administration.",
    ai: "Manage AI models, quotas, Skills, and usage.",
    "ai models": "Manage AI model configuration.",
    "ai models pricing": "Manage model reference prices.",
    "ai quotas background": "Inspect and release the background emergency stop.",
    "ai skills": "Inspect Assistant Skills and trusted templates.",
    "ai usage": "Inspect AI runs and usage facets.",
    announcements: "Manage platform announcements and banners.",
    "app-credentials": "Manage per-application credentials for background work.",
    "app-sign-in": "Manage app sign-in and pairing.",
    apps: "Inspect and remove registered apps.",
    documentation: "Manage the administration documentation website.",
    jobs: "Inspect background jobs and their runs.",
    logs: "Search, inspect, and clean up retained logs.",
    metrics: "Inspect collectors and manage metrics access.",
    "metrics tokens": "Manage metrics bearer tokens.",
    nats: "Inspect NATS nodes, streams, and consumers.",
    "nats consumers": "Inspect NATS consumers.",
    "nats streams": "Find NATS streams and buckets.",
    "notification-batches": "Manage account notification batches.",
    notifications: "Inspect and resend email notifications.",
    postgres: "Inspect Postgres diagnostics.",
    redis: "Inspect Valkey diagnostics.",
    routes: "Inspect gateway routes.",
    sync: "Inspect Sync resources, schedules, and dead letters.",
    "sync dead-letters": "Inspect, replay, requeue, or remove dead letters.",
    "sync resources": "List Sync resource declarations.",
    "sync schedules": "Inspect and run Sync schedules.",
    "sync schedules runs": "Read Sync schedule run results.",
    telemetry: "Inspect request telemetry.",
    webhooks: "Manage gateway health webhooks.",
    workflows: "Inspect and operate workflow runs and effects.",
    "app-sign-in config": "Manage the trusted app website and pairing policy.",
    "accounts config": "Manage account types and sign-in visibility.",
    "accounts administration": "Manage account requests and account/group follow-up notices.",
    "ai quotas": "Manage direct Assistant chat limits and consumption.",
    "ai quotas config": "Export and replace quota policies with revision checks.",
    legal: "Manage Terms, Privacy, and Imprint.",
    linux: "Prepare Linux identities.",
    "linux config": "Manage Linux identity defaults and allocation range.",
  },
  commands: [
    ...appCredentialCommands,
    ...documentationCommands,
    ...appSignInCommands,
    ...accountCategoryCommands,
    ...accountAdministrationCommands,
    ...aiUsageCommands,
    ...aiQuotaCommands,
    ...aiSkillCommands,
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
