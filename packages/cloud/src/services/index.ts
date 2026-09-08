// biome-ignore-all assist/source/organizeImports: Preserve grouped service barrel exports.
export { ipa } from "./ipa";
export { accounts } from "./accounts";
export { accountsAppService } from "./accounts";
export { posix as linuxIdentities, PosixError } from "./accounts/posix";
export type { PosixCandidate } from "./accounts/posix";
export { providers } from "./providers";
export { authFlows } from "./auth-flows";
export { toPgIntArray, toPgTextArray, toPgUuidArray, escapeLikePattern, isUniqueViolation } from "./postgres";

export { logger, logging, TRACE_STUCK_AFTER_MS, trace } from "./logging";
export {
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  stopRuntimeJobs,
  stopRuntimeResources,
  superviseRuntimeTask,
} from "./runtime-lifecycle";
export type { RuntimeTaskFailure, RuntimeTaskTracker } from "./runtime-lifecycle";
export type {
  LogEntry,
  TraceAttributeValue,
  TraceAttributes,
  TraceCategory,
  TraceContext,
  TraceEvent,
  TraceListFilter,
  TraceRunStats,
  TraceSeverity,
  TraceSpan,
  TraceSpanKind,
  TraceSourceGroup,
  TraceStatus,
  TraceSummary,
  TraceWindow,
} from "./logging";
export { audit } from "./audit";
export type { AuditActionGroup, AuditActor, AuditEvent, AuditListFilter, AuditOutcome, AuditRecordParams, AuditTarget } from "./audit";

export {
  GATEWAY_TELEMETRY_TENANT,
  ROUTE_TEMPLATE_HEADER,
  buildGatewayRouteSnapshot,
  gatewayTelemetryTopic,
  latestGatewayRouteSnapshot,
  listGatewayRouteSnapshots,
  publishGatewayRouteSnapshot,
  publishRequestTelemetry,
  removeGatewayRouteSnapshot,
} from "./gateway";
export type { GatewayRouteSnapshot, GatewayRouteSnapshotInput, GatewayRouteWarning, GatewayTelemetryEvent } from "./gateway";

export { notificationBatches, notifications } from "./notifications";
export { registerNotificationChannel } from "./notifications/channels";
export { startNotificationRuntime, stopNotificationRuntime } from "./notifications/runtime";
export { browserNotifications } from "./notifications/browser";
export type {
  NotificationBatch,
  NotificationBatchPreview,
  NotificationBatchRecipient,
  NotificationBatchRecipientStatus,
  NotificationBatchSelection,
  NotificationBatchStatus,
  NotificationType,
  NotificationStatus,
  SendNotificationParams,
  SendToUserParams,
  NotificationMessage,
} from "./notifications";
export type { NotificationChannelDriver } from "./notifications/channels";
export type { TypedNotificationDeliveryStatus, TypedNotificationSendResult } from "./notifications/platform";
export { announcements } from "./announcements";
export type { AnnouncementsService } from "./announcements";

export { session } from "./session";
export { mandateMetrics, mandates, startMandateMaintenance } from "./mandates";
export type {
  Mandate,
  MandateInteractiveAuthority,
  MandateIssueAuthority,
  MandateListScope,
  MandateMetricName,
  MandateMutationAuthority,
  MandatePolicyV1,
  MandateState,
  MandateSubject,
} from "./mandates";
export { serviceAccounts } from "./service-accounts";
export type { ServiceAccount, ServiceAccountKind, ServiceAccountStatus } from "./service-accounts";
export { serviceAccountCredentials } from "./service-account-credentials";
export type {
  AuthenticatedServiceAccountCredential,
  ServiceAccountCredential,
  ServiceAccountCredentialKind,
  ServiceAccountCredentialOverview,
  ServiceAccountCredentialOwner,
  ServiceAccountCredentialStatus,
} from "./service-account-credentials";
export { oauthTokens } from "./oauth-tokens";
export type { AuthenticatedOAuthToken } from "./oauth-tokens";
export { webauthn } from "./webauthn";
export type { WebAuthnRp } from "./webauthn";

export { accountLifecycle } from "./account-lifecycle";
export type { AccountLifecycleService } from "./account-lifecycle";
export type { AccountLifecycleNotificationSender } from "./account-lifecycle/notification-sender";
export { lifecycleJobs } from "./account-lifecycle/scheduler";

export { settings } from "./settings/namespace";
export { loadCache, get, set, remove, getAll } from "./settings";
export type { SettingEntry } from "./settings";
export { SETTINGS, SETTINGS_MAP, registerSettings } from "./settings/defaults";
export { validateSettingValue, normalizeSettingValue, getSettingLabel } from "./settings/defaults";
export type { SettingDef, SettingKind, SettingOption } from "./settings/defaults";
export { renderTemplate } from "./settings/templates";
export { settingsService } from "./settings/app";
export type { SettingsService } from "./settings/app";
export { decryptSecret, encryptSecret, secrets } from "./secrets";

// Typed async API + cache-aside primitives.
export { coreSettings, createSettingsAPI } from "./settings/api";
export type { SettingsAPI } from "./settings/api";
export {
  readKey as settingsReadKey,
  writeKey as settingsWriteKey,
  deleteKey as settingsDeleteKey,
  bulkRead as settingsBulkRead,
  allKnownKeys as settingsAllKnownKeys,
  listLegacyKeys as settingsListLegacyKeys,
  deleteLegacyKeys as settingsDeleteLegacyKeys,
} from "./settings/store";
export type { LegacySettingRow } from "./settings/store";
export { loadSnapshot as loadSettingsSnapshot } from "./settings/snapshot";

export { weatherService } from "./weather";
export type { WeatherService, WeatherData, DailyForecast, CurrentWeather, HourlyForecast, WeatherIcon } from "./weather";
export { migrate as migrateWeather } from "./weather/migrate";
export { getFreeIpaConfig } from "./freeipa-config";
export type { FreeIpaConfig } from "./freeipa-config";
export {
  GotenbergRenderError,
  MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES,
  MARKDOWN_PDF_TEMPLATE_IDS,
  MarkdownPdfError,
  buildMarkdownPdfHtml,
  getGotenbergConfig,
  mergePdfs,
  mergePdfsWithConfig,
  renderMarkdownToPdf,
  renderMarkdownToPdfWithConfig,
  renderHtmlToPdf,
  renderHtmlToPdfWithConfig,
  renderTemplatePdfPreview,
  testGotenberg,
} from "./pdf";
export type {
  GotenbergConfig,
  GotenbergRenderErrorCode,
  MarkdownPdfErrorCode,
  MarkdownPdfTemplateId,
  MergePdfsInput,
  RenderMarkdownToPdfInput,
  RenderMarkdownToPdfOptions,
  RenderTemplatePdfPreviewInput,
  RenderTemplatePdfPreviewOptions,
  RenderHtmlToPdfInput,
  RenderHtmlToPdfOptions,
  RenderHtmlToPdfResult,
  TemplatePdfPreviewError,
  TemplatePdfPreviewPhase,
  TemplatePdfPreviewResult,
} from "./pdf";

export { createSyncOpsRoutes, SYNC_OPS_DEAD_LETTER_LIMIT } from "./sync-ops";
export type {
  SyncDeadLetterEntry,
  SyncDeadLetterKind,
  SyncDeadLetterStoreView,
  SyncOpsRoutes,
  SyncOpsRoutesDependencies,
  SyncScheduleView,
} from "./sync-ops";

export { latestTopicCursor } from "./topic-cursor";
export { readAccountCategoryPolicy, isAccountCategoryAllowed } from "./account-category-policy";
export { appApproval, type AppDeviceEnrollmentNotice } from "./app-approval";
