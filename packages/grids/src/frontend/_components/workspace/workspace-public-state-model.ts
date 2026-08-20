import type { DateContext } from "@k2b/stdlib";
import type { z } from "zod";
import type { projectCustomApp, projectCustomAppSummaries } from "../../../api/custom-apps";
import type { PublicDslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicRecordHistoryEntry } from "../../../api/public-audit";
import type {
  PublicBase,
  PublicField,
  PublicForm,
  PublicGridFile,
  PublicGridRecord,
  PublicTable,
  PublicView,
} from "../../../api/public-dto";
import type {
  PublicGridsWorkflowLauncherSchema,
  PublicGridsWorkflowRunSchema,
  PublicGridsWorkflowRunStatsSchema,
  PublicGridsWorkflowSchema,
  PublicGridsWorkflowStepRunSchema,
  PublicWorkflowTriggerRuntimeStateSchema,
} from "../../../api/workflow-public-contracts";
import type { RecordDisplayConfig, RecordQuery } from "../../../contracts";
import type { CombinedRecordOrigin } from "../../../service";
import type {
  PublicDocumentRunBrowseResponse,
  PublicDocumentRunSummary,
  PublicDocumentTemplate,
  PublicDocumentTemplateSummary,
  PublicRecordSnapshotSummary,
} from "../documents/public-document-types";
import type { RecordsState } from "../records-view/query-url";
import type { GridsDocumentViewMode } from "../sidebar/GridsSettingsStore";
import type { WorkflowUrlState } from "../workflows/workflow-url-state";
import type { WorkspaceGroupBucket } from "./workspace-state-model";

export type PublicCustomApp = Awaited<ReturnType<typeof projectCustomApp>>;
export type PublicCustomAppSummary = Awaited<ReturnType<typeof projectCustomAppSummaries>>[number];
export type PublicWorkflow = z.infer<typeof PublicGridsWorkflowSchema>;
export type PublicWorkflowLauncher = z.infer<typeof PublicGridsWorkflowLauncherSchema>;
export type PublicWorkflowRun = z.infer<typeof PublicGridsWorkflowRunSchema>;
export type PublicWorkflowStepRun = z.infer<typeof PublicGridsWorkflowStepRunSchema>;
export type PublicWorkflowRunStats = z.infer<typeof PublicGridsWorkflowRunStatsSchema>;
export type PublicWorkflowTriggerRuntimeState = z.infer<typeof PublicWorkflowTriggerRuntimeStateSchema>;

export type PublicWorkspaceCatalog = {
  customApps: PublicCustomAppSummary[];
  workflows: PublicWorkflow[];
  workflowLaunchers: PublicWorkflowLauncher[];
  workflowLevels: Record<string, "none" | "read" | "write" | "admin">;
  tables: PublicTable[];
  tableLevels: Record<string, "none" | "read" | "write" | "admin">;
  fieldsByTable: Record<string, PublicField[]>;
  viewsByTable: Record<string, PublicView[]>;
  formsByTable: Record<string, PublicForm[]>;
  documentTemplatesByTable: Record<string, PublicDocumentTemplateSummary[]>;
  documentTemplateLevels: Record<string, "none" | "read" | "write" | "admin">;
  sidebarForms: Array<{ form: PublicForm; table: PublicTable }>;
  sidebarDocumentTemplates: Array<{ template: PublicDocumentTemplateSummary; table: PublicTable }>;
};

export type PublicRuntimeView = PublicView & { query: RecordQuery; displayConfig: RecordDisplayConfig };
export type PublicWorkspaceBulkLauncher = PublicWorkflowLauncher & { workflowRevision: number; workflowId: string };
export type PublicWorkspaceRecordLauncher = PublicWorkflowLauncher & { workflowRevision: number; workflowId: string };

export type PublicWorkspaceRecordDetail = {
  recordId: string;
  relationLabels: Record<string, string>;
  filesByField: Record<string, PublicGridFile[]>;
  documentRuns: PublicDocumentRunSummary[];
  snapshots: PublicRecordSnapshotSummary[];
  auditEntries: PublicRecordHistoryEntry[];
  combinedOrigin: CombinedRecordOrigin | null;
};

export type PublicWorkspaceRecordsRoute = {
  kind: "records";
  activeTable: PublicTable;
  activeView: PublicRuntimeView | null;
  fields: PublicField[];
  formsForTable: PublicForm[];
  canReadTable: boolean;
  canWriteRecords: boolean;
  canManageActiveTable: boolean;
  canEditActiveView: boolean;
  otherTables: Array<{ id: string; name: string }>;
  initialState: RecordsState;
  initialData: {
    items?: PublicGridRecord[];
    buckets?: WorkspaceGroupBucket[];
    aggregates?: Record<string, unknown>;
    nextCursor: string | null;
    explode?: boolean;
    filePreviews?: Record<
      string,
      Record<string, { fileId: string; fieldId: string; recordId: string; filename: string; mimeType: string; sizeBytes: number }>
    >;
  };
  initialSelectedRecord: PublicGridRecord | null;
  initialSelectedRecordDetail: PublicWorkspaceRecordDetail | null;
  documentTemplates: PublicDocumentTemplateSummary[];
  relationLabels: Record<string, string>;
  activeViewColumns: RecordQuery["columns"] | undefined;
  searchableFields: PublicField[];
  groupedExplode: boolean;
  activeRecordQuery: RecordQuery | null;
  displayConfig: RecordDisplayConfig;
  bulkSelectionLaunchers: PublicWorkspaceBulkLauncher[];
  recordActionLaunchers: PublicWorkspaceRecordLauncher[];
};

export type PublicWorkspaceQueryResultViewRoute = {
  kind: "queryResultView";
  activeTable: PublicTable;
  activeView: PublicView;
  fields: PublicField[];
  canManageActiveTable: boolean;
  canEditActiveView: boolean;
  initialCursor: string | null;
  initialResult: PublicDslQueryPreviewResponse | null;
};

export type PublicWorkspaceWorkflowOverview = {
  filters: WorkflowUrlState;
  stats: PublicWorkflowRunStats;
  runs: { items: PublicWorkflowRun[]; nextCursor: string | null };
  launchers: PublicWorkflowLauncher[];
  triggerState: PublicWorkflowTriggerRuntimeState | null;
};

export type PublicWorkspaceWorkflowRunDetail = {
  run: PublicWorkflowRun;
  inputLabels: Record<string, string>;
  provenance: { workflowName: string | null; actorLabel: string | null; serviceAccountLabel: string | null; launcherName: string | null };
  steps: PublicWorkflowStepRun[];
  stepsTruncated: boolean;
  documents: { items: PublicDocumentRunSummary[]; total: number; hasMore: boolean; nextOffset: number | null };
};

export type PublicWorkspaceRoute =
  | {
      kind: "customApp";
      app: PublicCustomApp;
      initialInspectorMode: "app" | "page";
    }
  | PublicWorkspaceRecordsRoute
  | PublicWorkspaceQueryResultViewRoute
  | {
      kind: "workflows";
      activeWorkflow: PublicWorkflow | null;
      canRunActiveWorkflow: boolean;
      canManageActiveWorkflow: boolean;
      selectedRunId: string | null;
      initialOverview: PublicWorkspaceWorkflowOverview;
      initialSelectedRun: PublicWorkspaceWorkflowRunDetail | null;
    }
  | {
      kind: "query";
      initialQuery: string;
      initialCursor: string | null;
      initialPreview?: PublicDslQueryPreviewResponse | null;
      queryPath: string;
      currentSource?:
        | { kind: "table"; tableId: string; label: string; ref: string }
        | { kind: "view"; viewId: string; label: string; ref: string };
    }
  | {
      kind: "documentTemplate";
      table: PublicTable;
      template: PublicDocumentTemplateSummary;
      editableTemplate: PublicDocumentTemplate | null;
      canWriteTemplate: boolean;
      canManageTemplate: boolean;
      initialRecordId: string | null;
      initialDocumentViewMode: GridsDocumentViewMode;
      initialBrowserPage: PublicDocumentRunBrowseResponse;
    }
  | { kind: "empty" };

type WorkspaceFailureState =
  | { kind: "notFound"; title: string; message: string }
  | { kind: "accessDenied"; title: string; message: string }
  | { kind: "invalidQuery"; title: string; message: string }
  | { kind: "redirect"; href: string };

export type PublicWorkspaceState =
  | WorkspaceFailureState
  | {
      kind: "ok";
      base: PublicBase;
      title: Array<{ title: string; href?: string }>;
      rememberPath: string;
      adminModeRequested: boolean;
      editModeToggleHref: string;
      canManageBase: boolean;
      canCreateTables: boolean;
      canUseEditMode: boolean;
      canUseQueryWorkspace: boolean;
      metadataEventCursor: string | null;
      recordEventCursor: string | null;
      dateConfig?: DateContext;
      catalog: PublicWorkspaceCatalog;
      route: PublicWorkspaceRoute;
    };

export type PublicOkWorkspaceState = Extract<PublicWorkspaceState, { kind: "ok" }>;
