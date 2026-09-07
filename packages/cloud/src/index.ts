export type { AppDefinition, AppOptions, StartOptions, StartResult } from "./_internal/define-app";
export { defineApp } from "./_internal/define-app";
export { createHeartbeat } from "./_internal/heartbeat";
export type { ProcessSync } from "./_internal/process-sync";
export {
  bindProcessSync,
  getProcessSync,
  lazySync,
  startProcessSync,
  unbindProcessSync,
} from "./_internal/process-sync";
export { APP_READINESS_PATH } from "./_internal/readiness";
export type { AppRegistryDetail, AppRegistryIssue, AppRegistrySnapshot, CapabilityRegistryRecord, DashboardWidget } from "./_internal/registry";
export {
  APP_REGISTRY_CONFIG,
  APP_REGISTRY_PREFIX,
  APP_REGISTRY_TTL_MS,
  CAPABILITY_REGISTRY_CONFIG,
  HELP_REGISTRY_CONFIG,
  appRegistry,
  capabilityRegistry,
  getApp,
  getHelp,
  helpRegistry,
  listApps,
  listAppsDetailed,
  listHelp,
  listLegalLinks,
  listWidgets,
  readAppRegistrySnapshot,
  watchAppRegistry,
} from "./_internal/registry";
export type { RuntimeCompatibilityIssue } from "./_internal/runtime-compatibility";
export { assessRuntimeCompatibility } from "./_internal/runtime-compatibility";
export { buildRuntimeFromRegistry } from "./_internal/runtime-context";
export { defineCapabilities } from "./contracts/capabilities";
export type {
  AnyBoundNotificationDefinition,
  BoundNotificationDefinition,
  BoundNotificationMap,
  EmailNotificationPresentation,
  NotificationChannelId,
  NotificationChannelRegistry,
  NotificationDefinition,
  NotificationDefinitionInput,
  NotificationDefinitionMap,
  NotificationDefinitionPresentationCatalog,
  NotificationDefinitionPresentationTranslation,
  NotificationDeliveryPolicy,
  NotificationPresentation,
  NotificationRecipient,
  NotificationRecipientKind,
  NotificationRenderContext,
  NotificationSendInput,
} from "./contracts/notification-types";
export { notification } from "./contracts/notification-types";
export type { HelpDefinition, HelpDefinitionDocument } from "./server/help";
export { defineHelp } from "./server/help";
