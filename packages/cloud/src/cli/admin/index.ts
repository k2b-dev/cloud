/**
 * `cld admin` — Cloud administration surfaces.
 *
 * Commands are grouped per domain in sibling modules; this file only composes
 * them. The groups map to the admin UI areas, so a command and the page that
 * shows the same data stay easy to find together.
 */

import { defineCliCommands } from "../commands";
import { type CloudCliContext, localizeCloudCliText } from "../index";
import { accountAdministrationCommands } from "./account-administration";
import { accountCategoryCommands } from "./account-categories";
import { administrationCommands } from "./administration";
import { agentCommands } from "./agents";
import { aiModelCommands } from "./ai-models";
import { aiQuotaCommands } from "./ai-quotas";
import { aiSkillCommands } from "./ai-skills";
import { aiUsageCommands } from "./ai-usage";
import { appCredentialCommands } from "./app-credentials";
import { appDomainCommands } from "./app-domains";
import { appKeyCommands } from "./app-keys";
import { appSignInCommands } from "./app-sign-in";
import { dataCommands } from "./data";
import { documentationCommands } from "./documentation";
import { gatewayCommands } from "./gateway";
import { geoipCommands } from "./geoip";
import { instanceCommands } from "./instance";
import { jobCommands } from "./jobs";
import { legalCommands } from "./legal";
import { linuxCommands } from "./linux";
import { logCommands } from "./logs";
import { metricsCommands } from "./metrics";
import { natsCommands } from "./nats";
import { notificationCommands } from "./notifications";
import { outgoingMailCommands } from "./outgoing-mail";
import { settingsCommands } from "./settings";
import { syncCommands } from "./sync";
import { telemetryCommands } from "./telemetry";
import { webhookCommands } from "./webhooks";
import { workflowCommands } from "./workflows";

const build = (locale?: string) =>
  defineCliCommands({
    name: "admin",
    summary: "Inspect and operate Cloud administration surfaces.",
    groupSummaries: {
      capabilities: "Inspect registered capabilities and their executions.",
      "capabilities executions": "List and inspect capability executions.",
      "ai enrichment": "Run AI enrichment for configured resources.",
      "ai projects": "Inspect AI projects and manage their access.",
      "ai projects access": "Manage AI project access grants.",
      chat: "Inspect Chat operational status.",
      contacts: "Inspect address books and manage their access.",
      "contacts access": "Manage address book access grants.",
      "directory-shares": "Manage directory sharing with recipient apps.",
      files: "Inspect file provisioning and manage machine storage.",
      "files machines": "Provision machine storage and manage its grants.",
      "files machines grants": "Manage machine storage grants.",
      geo: "Inspect Geo usage and configure its key and budget.",
      "geo key": "Replace or remove the Geo API key.",
      "geo budget": "Configure the Geo request budget.",
      identity: "Inspect identity keys and mandates.",
      "identity keys": "Inspect identity signing key status.",
      "identity mandates": "Inspect identity mandates.",
      lifecycle: "Inspect and run account lifecycle maintenance.",
      retention: "Inspect retention policies across applications.",
      "logs retention": "Read or configure log retention.",
      "proxy-auth": "Manage proxy authentication clients.",
      rail: "Configure the app bar and clear its cache.",
      "settings legacy": "Inspect or remove legacy settings.",
      "settings test": "Test configured platform connections.",
      spaces: "Inspect Spaces and recover their access.",
      "spaces access": "Manage Space access grants for recovery.",
      studio: "Manage Studio machine configuration.",
      "studio machines": "Manage machine access and stored secrets.",
      "studio machines access": "Inspect and configure machine access.",
      "studio machines secrets": "Manage machine secret presence and replacements.",
      weather: "Configure Weather defaults.",
      "weather config": "Replace or reset Weather settings.",
      accounts: "Manage account policy and account administration.",
      ai: "Manage AI models, quotas, Skills, and usage.",
      "ai models": "Manage AI model configuration.",
      "ai providers": "Manage AI provider connections.",
      "ai variants": "Manage named model variants.",
      "ai classes": "Manage model classes and tools.",
      "ai quotas background": "Inspect and release the background emergency stop.",
      "ai skills": "Inspect Assistant Skills and trusted templates.",
      "ai usage": "Inspect AI runs and usage facets.",
      announcements: "Manage platform announcements and banners.",
      "app-credentials": "Manage per-application credentials for background work.",
      agents: "Create, list, revoke, and re-key agent accounts with OAuth client credentials, and change their pictures.",
      "agents avatar": "Show and change an agent's picture: its robot parts or a photo.",
      "app-sign-in": "Manage app sign-in and pairing.",
      apps: localizeCloudCliText(locale, {
        en: "Inspect registered apps and manage app keys and domains.",
        de: "Registrierte Apps prüfen und App-Schlüssel und App-Domains verwalten.",
      }),
      "apps domains": localizeCloudCliText(locale, {
        en: "Assign app domains and inspect DNS, TLS and gateway reachability.",
        de: "App-Domains zuordnen und DNS, TLS und Gateway-Erreichbarkeit prüfen.",
      }),
      "apps keys": "Create, list, and revoke Ed25519 app keys.",
      documentation: "Manage the administration documentation website.",
      geoip: "Replace and inspect sign-in location databases.",
      jobs: "Inspect background jobs and their runs.",
      logs: "Search, inspect, and clean up retained logs.",
      metrics: "Inspect collectors and manage metrics access.",
      "metrics tokens": "Manage metrics bearer tokens.",
      nats: "Inspect NATS nodes, streams, and consumers.",
      "nats consumers": "Inspect NATS consumers.",
      "nats streams": "Find NATS streams and buckets.",
      "notification-batches": "Manage account notification batches.",
      "outgoing-mail": "Manage outgoing mail sender profiles, application access, and the send log.",
      "outgoing-mail profiles": "Manage outgoing mail sender profiles.",
      "outgoing-mail apps": "Manage application outgoing mail access.",
      "outgoing-mail log": "Read and cancel application mail in the send log.",
      "outgoing-mail retention": "Show or change how long the send log keeps mail.",
      notifications: "Inspect and resend email notifications.",
      postgres: "Inspect Postgres diagnostics.",
      redis: "Inspect Valkey diagnostics.",
      routes: "Inspect gateway routes.",
      settings: "Inspect environment migration and change administrator settings.",
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
      ...appKeyCommands,
      ...appDomainCommands(locale),
      ...agentCommands,
      ...documentationCommands,
      ...appSignInCommands,
      ...accountCategoryCommands,
      ...accountAdministrationCommands,
      ...aiUsageCommands,
      ...aiModelCommands,
      ...aiQuotaCommands,
      ...aiSkillCommands,
      ...instanceCommands,
      ...gatewayCommands,
      ...logCommands,
      ...telemetryCommands,
      ...jobCommands,
      ...legalCommands,
      ...geoipCommands,
      ...linuxCommands,
      ...workflowCommands,
      ...dataCommands,
      ...notificationCommands,
      ...outgoingMailCommands,
      ...webhookCommands,
      ...metricsCommands,
      ...natsCommands,
      ...syncCommands,
      ...settingsCommands,
      ...administrationCommands,
    ],
  });

const admin = build();
export default {
  ...admin,
  help: (locale?: string) => build(locale).help?.(locale) ?? "",
  run: (ctx: CloudCliContext) => build(ctx.options.locale).run(ctx),
};
