import type { DateContext } from "@k2b/stdlib";
import type { PanesLayout } from "@k2b/ui";
import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { PermissionLevel } from "@k2b/cloud/contracts";
import type {
  MetricQueryPoint,
  PulseBase,
  PulseCapabilitySnapshot,
  PulseCurrentState,
  PulseDashboard,
  PulseExplorerQuery,
  PulseInventory,
  PulseMapSeries,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseSavedQuery,
  PulseSource,
  PulseSourceScrape,
} from "../../contracts";

export type { WorkspaceView } from "./routes";

import type { ActivityQueryState, ResourceQueryState, WorkspaceRouteState } from "./routes";

export type MetricTextQueryResult = {
  compiled: PulseExplorerQuery;
  points: MetricQueryPoint[];
  events: PulseRecordedEvent[];
  states: PulseCurrentState[];
};

export type SourceCreateKind = "metrics" | "http_ingest";
export type GrantableLevel = Exclude<PermissionLevel, "none">;
export type ExplorerResultView = "chart" | "table" | "compiled";
export type QueryHistoryEntry = { query: string; ranAt: string };
export type RefreshIntervalOption = "1" | "5" | "10" | "60" | "never";

export type PulseWorkspaceQueryCoverage = {
  activity: boolean;
  baseData: boolean;
  bases: boolean;
  dashboard: boolean;
  focused: boolean;
  resources: boolean;
  resourceSignals: boolean;
  sourceDetail: boolean;
};

export type BrowseEntity = {
  id: string;
  type: string | null;
  sourceIds: string[];
  metricCount: number;
  eventCount: number;
  stateCount: number;
  dimensions: Record<string, string>;
};

export type ActivityEventGroup = {
  id: string;
  kind: string;
  subject: string;
  sourceId: string | null;
  latest: PulseRecordedEvent;
  rows: PulseRecordedEvent[];
};

export type ActivityStateGroup = {
  id: string;
  key: string;
  sourceId: string | null;
  latest: PulseCurrentState;
  rows: PulseCurrentState[];
};

export type CreateSourceInput = {
  kind: SourceCreateKind;
  name: string;
  endpointUrl?: string;
  bearerToken?: string;
  scrapeIntervalSeconds?: number;
};

export type PulseWorkspaceProps = {
  initialBases: PulseBase[];
  initialCapabilities: PulseCapabilitySnapshot | null;
  initialQueryCoverage: PulseWorkspaceQueryCoverage;
  initialBaseId?: string | null;
  initialPath?: string;
  initialSearch?: string;
  initialRouteState?: WorkspaceRouteState;
  initialActivityQuery?: ActivityQueryState;
  initialResourceQuery?: ResourceQueryState;
  initialSources?: PulseSource[];
  initialSourceScrapes?: Record<string, PulseSourceScrape[]>;
  initialSourceApiKeys?: Record<string, ResourceApiKey[]>;
  initialMetrics?: PulseMetricSummary[];
  initialInventory?: PulseInventory;
  initialActivityMetrics?: PulseMetricSummary[];
  initialSeries?: PulseMetricSeries[];
  initialRecentEvents?: PulseRecordedEvent[];
  initialCurrentStates?: PulseCurrentState[];
  initialFocusedMetricSeries?: PulseMetricSeries[];
  initialFocusedEvents?: PulseRecordedEvent[];
  initialFocusedStates?: PulseCurrentState[];
  initialFocusedHasMore?: boolean;
  initialDashboards?: PulseDashboard[];
  initialDashboardControlValues?: Record<string, string>;
  initialSavedQueries?: PulseSavedQuery[];
  initialMetricWidgetPoints?: Record<string, MetricQueryPoint[]>;
  initialDashboardEvents?: Record<string, PulseRecordedEvent[]>;
  initialDashboardStates?: Record<string, PulseCurrentState[]>;
  initialDashboardMaps?: Record<string, PulseMapSeries[]>;
  initialExplorerPanesLayout?: PanesLayout | null;
  initialDashboardEditorPanesLayout?: PanesLayout | null;
  initialDateConfig?: DateContext;
  initialNow?: string;
  initialOrigin?: string;
};
