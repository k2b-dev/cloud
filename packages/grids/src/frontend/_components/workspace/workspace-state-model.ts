import type { DateContext } from "@k2b/stdlib";
import type {
  DocumentBrowseResponse,
  DocumentSummary,
  DocumentTemplate,
  DocumentTemplateSummary,
  DslQueryPreviewResponse,
  RecordDisplayConfig,
  RecordQuery,
  RecordSnapshotSummary,
} from "../../../contracts";
import type {
  Base,
  CombinedRecordOrigin,
  CustomApp,
  CustomAppSummary,
  Field,
  Form,
  GridFile,
  GridRecord,
  RecordHistoryEntry,
  Table,
  View,
  Workflow,
} from "../../../service";
import type {
  GridsWorkflowLauncher,
  GridsWorkflowRun,
  GridsWorkflowRunStats,
  GridsWorkflowStepRun,
  WorkflowTriggerRuntimeState,
} from "../../../workflows/contracts";
import type { RecordsState } from "../records-view/query-url";
import type { GridsDocumentViewMode } from "../sidebar/GridsSettingsStore";
import type { WorkflowUrlState } from "../workflows/workflow-url-state";

export type AuthUser = {
  id: string;
  memberofGroupIds: string[];
};

export type WorkspaceGroupBucket = {
  keys: unknown[];
  values: Record<string, unknown>;
};

export type WorkspaceCatalog = {
  customApps: CustomAppSummary[];
  workflows: Workflow[];
  workflowLaunchers: GridsWorkflowLauncher[];
  workflowLevels: Record<string, "none" | "read" | "write" | "admin">;
  tables: Table[];
  tableLevels: Record<string, "none" | "read" | "write" | "admin">;
  fieldsByTable: Record<string, Field[]>;
  viewsByTable: Record<string, View[]>;
  formsByTable: Record<string, Form[]>;
  documentTemplatesByTable: Record<string, DocumentTemplateSummary[]>;
  documentTemplateLevels: Record<string, "none" | "read" | "write" | "admin">;
  tableShortIds: Record<string, string>;
  sidebarForms: Array<{ form: Form; table: Table }>;
  sidebarDocumentTemplates: Array<{ template: DocumentTemplateSummary; table: Table }>;
};

export type RuntimeView = View & {
  query: RecordQuery;
  displayConfig: RecordDisplayConfig;
};

export type WorkspaceBulkLauncher = GridsWorkflowLauncher & { workflowRevision: number; workflowShortId: string };
export type WorkspaceRecordLauncher = GridsWorkflowLauncher & {
  workflowRevision: number;
  workflowShortId: string;
  correctionPrefillFieldCount: number;
};

export type WorkspaceRecordsRoute = {
  kind: "records";
  activeTable: Table;
  activeView: RuntimeView | null;
  fields: Field[];
  formsForTable: Form[];
  canReadTable: boolean;
  canWriteRecords: boolean;
  canManageActiveTable: boolean;
  canEditActiveView: boolean;
  otherTables: Array<{ id: string; name: string }>;
  initialState: RecordsState;
  initialData: {
    items?: GridRecord[];
    buckets?: WorkspaceGroupBucket[];
    aggregates?: Record<string, unknown>;
    nextCursor: string | null;
    explode?: boolean;
    filePreviews?: Record<
      string,
      Record<string, { fileId: string; fieldId: string; recordId: string; filename: string; mimeType: string; sizeBytes: number }>
    >;
  };
  initialSelectedRecord: GridRecord | null;
  initialSelectedRecordDetail: WorkspaceRecordDetail | null;
  documentTemplates: DocumentTemplateSummary[];
  relationLabels: Record<string, string>;
  activeViewColumns: RecordQuery["columns"] | undefined;
  searchableFields: Field[];
  groupedExplode: boolean;
  activeRecordQuery: RecordQuery | null;
  displayConfig: RecordDisplayConfig;
  bulkSelectionLaunchers: WorkspaceBulkLauncher[];
  recordActionLaunchers: WorkspaceRecordLauncher[];
};

export type WorkspaceQueryResultViewRoute = {
  kind: "queryResultView";
  activeTable: Table;
  activeView: View;
  fields: Field[];
  canManageActiveTable: boolean;
  canEditActiveView: boolean;
  initialCursor: string | null;
  initialResult: DslQueryPreviewResponse | null;
};

export type WorkspaceRecordDetail = {
  recordId: string;
  relationLabels: Record<string, string>;
  filesByField: Record<string, GridFile[]>;
  documents: { items: DocumentSummary[]; nextCursor: string | null; hasMore: boolean };
  snapshots: RecordSnapshotSummary[];
  auditEntries: RecordHistoryEntry[];
  combinedOrigin: CombinedRecordOrigin | null;
};

type WorkspaceEmptyRoute = {
  kind: "empty";
};

type WorkspaceDocumentsRoute = { kind: "documents" };

type WorkspaceWorkflowsRoute = {
  kind: "workflows";
  activeWorkflow: Workflow | null;
  canRunActiveWorkflow: boolean;
  canManageActiveWorkflow: boolean;
  selectedRunId: string | null;
  initialOverview: WorkspaceWorkflowOverview;
  initialSelectedRun: WorkspaceWorkflowRunDetail | null;
};

type WorkspaceWorkflowOverview = {
  filters: WorkflowUrlState;
  stats: GridsWorkflowRunStats;
  runs: { items: GridsWorkflowRun[]; nextCursor: string | null };
  launchers: GridsWorkflowLauncher[];
  triggerState: WorkflowTriggerRuntimeState | null;
};

export type WorkspaceWorkflowRunDetail = {
  run: GridsWorkflowRun;
  inputLabels: Record<string, string>;
  provenance: {
    workflowName: string | null;
    actorLabel: string | null;
    serviceAccountLabel: string | null;
    launcherName: string | null;
  };
  steps: GridsWorkflowStepRun[];
  stepsTruncated: boolean;
  documents: {
    items: DocumentSummary[];
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
};

type WorkspaceQueryRoute = {
  kind: "query";
  initialQuery: string;
  initialCursor: string | null;
  initialPreview?: DslQueryPreviewResponse | null;
  queryPath: string;
  currentSource?:
    | { kind: "table"; tableId: string; label: string; ref: string }
    | { kind: "view"; viewId: string; label: string; ref: string };
};

type WorkspaceDocumentTemplateRoute = {
  kind: "documentTemplate";
  table: Table;
  template: DocumentTemplateSummary;
  editableTemplate: DocumentTemplate | null;
  canWriteTemplate: boolean;
  canManageTemplate: boolean;
  initialRecordId: string | null;
  initialDocumentViewMode: GridsDocumentViewMode;
  initialBrowserPage: DocumentBrowseResponse;
};

type WorkspaceCustomAppRoute = {
  kind: "customApp";
  app: CustomApp;
  initialSettingsOpen: boolean;
};

export type GridsWorkspaceRoute =
  | WorkspaceCustomAppRoute
  | WorkspaceRecordsRoute
  | WorkspaceQueryResultViewRoute
  | WorkspaceWorkflowsRoute
  | WorkspaceQueryRoute
  | WorkspaceDocumentTemplateRoute
  | WorkspaceDocumentsRoute
  | WorkspaceEmptyRoute;

export type GridsWorkspaceState =
  | { kind: "notFound"; title: string; message: string }
  | { kind: "accessDenied"; title: string; message: string }
  | { kind: "invalidQuery"; title: string; message: string }
  | { kind: "redirect"; href: string }
  | {
      kind: "ok";
      base: Base;
      baseShortId: string;
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
      catalog: WorkspaceCatalog;
      route: GridsWorkspaceRoute;
    };

export type LoadWorkspaceParams = {
  user: AuthUser;
  baseShortId: string;
  href: string;
  activeTableSlug?: string | null;
  activeViewSlug?: string | null;
  activeWorkflowSlug?: string | null;
  activeDocumentTableSlug?: string | null;
  activeDocumentTemplateSlug?: string | null;
  documentsRequested?: boolean;
  activeCustomAppSlug?: string | null;
  initialDocumentViewMode?: GridsDocumentViewMode;
  dateConfig?: DateContext;
  locale?: string;
};

export type WorkspaceChrome = {
  url: URL;
  adminModeRequested: boolean;
  trashMode: boolean;
  rememberPath: string;
  editModeToggleHref: string;
  titleBase: Array<{ title: string; href?: string }>;
};

export type WorkspaceCommon = {
  params: LoadWorkspaceParams;
  base: Base;
  chrome: WorkspaceChrome;
  catalog: WorkspaceCatalog;
  canManageBase: boolean;
  canCreateTables: boolean;
  canUseEditMode: boolean;
  canUseQueryWorkspace: boolean;
  metadataEventCursor: string | null;
  recordEventCursor: string | null;
};

export type OkWorkspaceState = Extract<GridsWorkspaceState, { kind: "ok" }>;
