import * as access from "./access";
import * as audit from "./audit";
import * as baseCatalog from "./base-catalog";
import * as bases from "./bases";
import * as documentIssuance from "./document-issuance";
import * as combinedAudit from "./combined-audit";
import * as controlledDestruction from "./controlled-destruction";
import * as customApps from "./custom-apps";
import * as documents from "./documents";
import * as durableHistory from "./durable-history";
import * as emailTemplates from "./email-templates";
import * as evidenceExports from "./evidence-exports";
import * as exporter from "./export";
import * as federatedTables from "./federated-tables";
import { getFieldDependents, hasBlockingDependents } from "./field-dependents";
import * as fields from "./fields";
import * as files from "./files";
import { submitForm } from "./form-submission";
import * as forms from "./forms";
import * as formulaPreview from "./formula-preview";
import * as htmlTemplatePreview from "./html-template-preview";
import * as metadataEvents from "./metadata-events";
import * as mutationPolicy from "./mutation-policy";
import { getOperationalHealth } from "./operational-health";
import {
  hasAtLeast,
  hasGrantsForResource,
  loadBaseGrantsForSubject,
  loadCustomAppGrantsForSubject,
  resolveEffectivePermission,
} from "./permission-resolver";
import * as preservationHolds from "./preservation-holds";
import * as recordChangeFeed from "./record-change-feed";
import * as recordComments from "./record-comments";
import { listDeadRecordEventDeliveryFailures } from "./record-event-delivery-failures";
import * as recordExternalIdentity from "./record-external-identity";
import * as recordFinalization from "./record-finalization";
import * as recordHistory from "./record-history";
import * as records from "./records";
import * as referencedBy from "./referenced-by";
import * as relationsModule from "./relations";
import * as retentionPolicy from "./retention-policy";
import * as tableAdminOverview from "./table-admin-overview";
import * as tables from "./tables";
import * as templates from "./templates";
import * as views from "./views";
import {
  createWorkflow,
  getWorkflow,
  getWorkflowByShortIdForBase,
  listRecordEventBaseIds,
  listRecordEventWorkflows,
  listScheduledWorkflows,
  listWorkflowScopes,
  listWorkflows,
  removeWorkflow,
  updateWorkflow,
  validateWorkflowSource,
} from "./workflow-definitions";
import { invokeBulkLauncher, invokeCustomAppLauncher, invokeScannerLauncher } from "./workflow-launcher-invocations";
import { createLauncher, getLauncher, listLaunchers, listLaunchersForBase, removeLauncher, updateLauncher } from "./workflow-launchers";
import { replayWorkflowRecordEventDeliveryFailure } from "./workflow-record-events";
import { getWorkflowRun, getWorkflowRunByShortId } from "./workflow-runs";
import { invokeGridsWorkflow, reconcileWorkflowRuntime, startWorkflowRuntime, stopWorkflowRuntime } from "./workflow-runtime";

export const gridsService = {
  operations: {
    health: getOperationalHealth,
  },
  base: {
    list: bases.list,
    listVisible: bases.listVisible,
    catalog: baseCatalog.listForBase,
    get: bases.get,
    getByShortId: bases.getByShortId,
    create: bases.create,
    update: bases.update,
    remove: bases.remove,
    restore: bases.restore,
    retentionPolicy,
    preservationHolds,
    controlledDestruction,
    admin: {
      list: bases.adminList,
      summary: bases.adminSummary,
    },
  },
  table: {
    listByBase: tables.listByBase,
    adminOverview: tableAdminOverview,
    listTrashedByBase: tables.listTrashedByBase,
    get: tables.get,
    getByShortId: tables.getByShortId,
    getByShortIdForBase: tables.getByShortIdForBase,
    create: tables.create,
    update: tables.update,
    remove: tables.remove,
    restore: tables.restore,
    durableHistory: {
      getStatus: durableHistory.getStatus,
      enable: durableHistory.enable,
      continueActivation: durableHistory.continueActivation,
    },
    finalization: {
      getStatus: recordFinalization.getStatus,
    },
    mutationPolicy: {
      getImpact: mutationPolicy.getImpact,
      update: mutationPolicy.update,
    },
    federation: {
      getDraft: federatedTables.getDraft,
      getCurrent: federatedTables.getCurrent,
      getActive: federatedTables.getActive,
      captureRevisionScope: federatedTables.captureRevisionScope,
      validateDraft: federatedTables.validateDraft,
      sourceIdsRequiringAuthorization: federatedTables.sourceIdsRequiringAuthorization,
      listSourceCandidates: federatedTables.listSourceCandidates,
      updateDraft: federatedTables.updateDraft,
      publishDraft: federatedTables.publishDraft,
      revokeSource: federatedTables.revokeSource,
      listPublicationsForSource: federatedTables.listPublicationsForSource,
      refreshForField: federatedTables.refreshForField,
      refreshForSourceTable: federatedTables.refreshForSourceTable,
      refreshForSourceBase: federatedTables.refreshForSourceBase,
    },
  },
  field: {
    listByTable: fields.listByTable,
    listByTables: fields.listByTables,
    listTrashedByBase: fields.listTrashedByBase,
    get: fields.get,
    getByShortId: fields.getByShortId,
    getByShortIdForTable: fields.getByShortIdForTable,
    create: fields.create,
    update: fields.update,
    reorder: fields.reorder,
    softDelete: fields.softDelete,
    restore: fields.restore,
  },
  record: {
    list: records.list,
    countAccessibleByTable: records.countAccessibleByTable,
    get: records.get,
    getByShortId: records.getByShortId,
    findTableId: records.findTableId,
    create: records.create,
    createMany: records.createMany,
    external: recordExternalIdentity,
    changes: recordChangeFeed,
    eventOutboxStats: records.recordEventOutboxStats,
    redriveEventOutbox: records.redriveRecordEventOutbox,
    update: records.update,
    softDelete: records.softDelete,
    restore: records.restore,
    listActors: records.listActors,
    aggregate: records.aggregate,
    group: records.group,
    listReferencedBy: referencedBy.listReferencedBy,
    durableHistory: {
      list: durableHistory.listRecordRevisions,
      get: durableHistory.getRevision,
      getFileContent: durableHistory.getRevisionFileContent,
    },
    finalization: {
      finalize: recordFinalization.finalize,
    },
    comments: {
      list: recordComments.list,
      create: recordComments.create,
      update: recordComments.update,
      remove: recordComments.remove,
      getByShortId: recordComments.getByShortId,
    },
  },
  audit: {
    log: audit.logAudit,
    list: audit.listAudit,
    listByRecord: recordHistory.listByRecord,
    combined: {
      describeRecord: combinedAudit.describeRecord,
      list: combinedAudit.list,
    },
  },
  evidenceExport: {
    preflight: evidenceExports.preflight,
    create: evidenceExports.create,
    listByBase: evidenceExports.listByBase,
    getByShortId: evidenceExports.getByShortId,
    retry: evidenceExports.retry,
    cancel: evidenceExports.cancel,
    download: evidenceExports.download,
  },
  permission: {
    resolve: resolveEffectivePermission,
    loadBaseGrantsForSubject,
    loadCustomAppGrantsForSubject,
    hasAtLeast,
    hasGrantsForResource,
  },
  fieldDependents: {
    get: getFieldDependents,
    hasBlocking: hasBlockingDependents,
  },
  access: {
    grant: access.grantAccess,
    listForBase: access.listBaseAccess,
    listForBaseTree: access.listAccessForBaseTree,
    listForCustomApp: access.listCustomAppAccess,
    updateLevel: access.updateAccessLevel,
    revoke: access.revokeAccess,
    resolveBinding: access.resolveAccessBinding,
    resolveResource: access.resolveResourceBinding,
  },
  customApp: {
    compile: customApps.compile,
    plan: customApps.plan,
    apply: customApps.apply,
    saveDraft: customApps.saveDraft,
    restoreDraft: customApps.restoreDraft,
    createBlank: customApps.createBlank,
    publish: customApps.publish,
    unpublish: customApps.unpublish,
    remove: customApps.remove,
    get: customApps.get,
    getByShortIdForBase: customApps.getByShortIdForBase,
    getPublishedByShortId: customApps.getPublishedByShortId,
    listByBase: customApps.listByBase,
    listSummariesByBase: customApps.listSummariesByBase,
  },
  view: {
    listForTable: views.listForTable,
    listForTables: views.listForTables,
    get: views.get,
    getByShortId: views.getByShortId,
    getByShortIdForTable: views.getByShortIdForTable,
    create: views.create,
    update: views.update,
    remove: views.remove,
    restore: views.restore,
  },
  document: {
    listTemplatesForTable: documents.listTemplatesForTable,
    getTemplate: documents.getTemplate,
    getStoredTemplate: documents.getStoredTemplate,
    getTemplateByShortId: documents.getTemplateByShortId,
    getTemplateByShortIdForTable: documents.getTemplateByShortIdForTable,
    summarizeTemplate: documents.summarizeTemplate,
    createTemplate: documents.createTemplate,
    updateTemplate: documents.updateTemplate,
    reorderTemplates: documents.reorderTemplates,
    removeTemplate: documents.removeTemplate,
    restoreTemplate: documents.restoreTemplate,
    createRecordSnapshot: documents.createRecordSnapshot,
    createRecordSnapshotDraft: documents.createRecordSnapshotDraft,
    filterSnapshotRelatedRecords: documents.filterSnapshotRelatedRecords,
    getSnapshot: documents.getSnapshot,
    getSnapshotByShortId: documents.getSnapshotByShortId,
    listSnapshotsForRecord: documents.listSnapshotsForRecord,
    buildTemplateAppData: documents.buildTemplateAppData,
    buildTemplateInputContext: documents.buildTemplateInputContext,
    buildRenderData: documents.buildRenderData,
    buildDocumentRenderData: documents.buildDocumentRenderData,
    buildLiveRenderData: documents.buildLiveRenderData,
    rowsWithColumnLabels: documents.rowsWithColumnLabels,
    renderSource: documents.renderDocumentSource,
    renderHtml: documents.renderDocumentHtml,
    renderPdfPreview: documents.renderDocumentPdfPreview,
    renderProfileInput: documents.renderDocumentProfileInput,
    createDocumentForRecord: documents.createDocumentForRecord,
    issueDocument: documentIssuance.documentIssuanceService.issueDocument,
    profiles: documentIssuance.documentIssuanceService.profiles,
    preview: documentIssuance.documentIssuanceService.preview,
    listForBase: documents.listDocumentsForBase,
    listForRecord: documents.listDocumentsForRecord,
    listDocumentSummariesForRecordByTemplates: documents.listDocumentSummariesForRecordByTemplates,
    listDocumentsForWorkflow: documents.listDocumentsForWorkflow,
    listDocumentsForTemplate: documents.listDocumentsForTemplate,
    browseDocumentsForTemplate: documents.browseDocumentsForTemplate,
    summarizeDocument: documents.summarizeDocument,
    getDocument: documents.getDocument,
    getDocumentByShortId: documents.getDocumentByShortId,
    getDocumentArtifacts: documents.getDocumentArtifacts,
    getDocumentArtifact: documents.getDocumentArtifact,
    listDocumentLinks: documents.listDocumentLinksForDocument,
    getDocumentLink: documents.getDocumentLink,
    getDocumentLinkByShortId: documents.getDocumentLinkByShortId,
    createDocumentLink: documents.createDocumentLink,
    revokeDocumentLink: documents.revokeDocumentLink,
    resolveDocumentLinkDownload: documents.resolveDocumentLinkDownload,
    recordDocumentLinkAccess: documents.recordDocumentLinkAccess,
    publicDocumentLinkPath: documents.publicDocumentLinkPath,
    publicDocumentLinkUrl: documents.publicDocumentLinkUrl,
    getPdf: documents.getDocumentPdf,
    renderWorkflowDocumentsPdf: documents.renderWorkflowDocumentsPdf,
  },
  emailTemplate: {
    listForBase: emailTemplates.listForBase,
    listDependenciesForBase: emailTemplates.listDependenciesForBase,
    get: emailTemplates.get,
    getByShortId: emailTemplates.getByShortId,
    getByShortIdForBase: emailTemplates.getByShortIdForBase,
    create: emailTemplates.create,
    update: emailTemplates.update,
    remove: emailTemplates.remove,
    render: emailTemplates.renderEmailTemplate,
    validateWrite: emailTemplates.validateEmailTemplateWrite,
  },
  form: {
    listForTable: forms.listForTable,
    listTrashedByBase: forms.listTrashedByBase,
    get: forms.get,
    getByShortId: forms.getByShortId,
    getByShortIdForTable: forms.getByShortIdForTable,
    getByPublicToken: forms.getByPublicToken,
    create: forms.create,
    update: forms.update,
    remove: forms.remove,
    restore: forms.restore,
    buildDefault: forms.buildDefaultForm,
    toRenderableForm: forms.toRenderableForm,
    toPublicRenderableForm: forms.toPublicRenderableForm,
    submit: submitForm,
  },
  file: {
    listForRecord: files.listForRecord,
    listForRecordField: files.listForRecordField,
    listFirstImagePreviews: files.listFirstImagePreviews,
    upload: files.upload,
    replace: files.replace,
    getByShortId: files.getByShortId,
    getContent: files.getContent,
    remove: files.remove,
    protect: files.protect,
    releaseProtection: files.releaseProtection,
    getProtectedContent: files.getProtectedContent,
    cleanup: files.cleanup,
  },
  workflow: {
    listForBase: listWorkflows,
    listScopesForBase: listWorkflowScopes,
    listEnabledForBase: (baseId: string) => listWorkflows(baseId, true),
    listScheduledEnabled: listScheduledWorkflows,
    listRecordEventBaseIds,
    listRecordEventEnabled: listRecordEventWorkflows,
    get: getWorkflow,
    getByShortIdForBase: getWorkflowByShortIdForBase,
    create: createWorkflow,
    update: updateWorkflow,
    remove: removeWorkflow,
    validate: validateWorkflowSource,
    getRun: getWorkflowRun,
    getRunByShortId: getWorkflowRunByShortId,
    invoke: invokeGridsWorkflow,
    launcher: {
      get: getLauncher,
      list: listLaunchers,
      listForBase: listLaunchersForBase,
      create: createLauncher,
      update: updateLauncher,
      remove: removeLauncher,
      invokeScanner: invokeScannerLauncher,
      invokeBulk: invokeBulkLauncher,
      invokeCustomApp: invokeCustomAppLauncher,
    },
    runtime: {
      start: startWorkflowRuntime,
      stop: stopWorkflowRuntime,
      reconcile: reconcileWorkflowRuntime,
      listDeadRecordEvents: listDeadRecordEventDeliveryFailures,
      replayDeadRecordEvent: replayWorkflowRecordEventDeliveryFailure,
    },
  },
  template: {
    list: templates.list,
    get: templates.get,
    instantiate: templates.instantiate,
  },
  exporter: {
    exportRecords: exporter.exportRecords,
  },
  formulaPreview: {
    check: formulaPreview.checkFormula,
  },
  htmlTemplatePreview: {
    check: htmlTemplatePreview.checkHtmlTemplate,
  },
  relations: {
    buildLabelCache: relationsModule.buildRelationLabelCache,
    buildPinnedLabelCache: relationsModule.buildPinnedRelationLabelCache,
    buildLabelCacheForGroupedKeys: relationsModule.buildLabelCacheForGroupedKeys,
    buildExpansionCache: relationsModule.buildRelationExpansionCache,
    lookup: relationsModule.lookupRecords,
  },
  metadataEvents,
};

export type {
  AggregationSpec,
  GroupBySpec,
  View,
} from "../contracts";
export type { GridsWorkflow as Workflow } from "../workflows/contracts";
export type { CombinedAuditEntry, CombinedAuditPage, CombinedRecordOrigin } from "./combined-audit";
export type { CustomApp, CustomAppSummary } from "./custom-apps";
export type { Form, FormFieldEntry } from "./forms";
export type { Grant, ResolveTarget, ResourceType } from "./permission-resolver";
export type { RecordHistoryEntry } from "./record-history";
export type {
  Base,
  Field,
  GridFile,
  GridFilePreview,
  GridRecord,
  RecordList,
  Table,
} from "./types";
