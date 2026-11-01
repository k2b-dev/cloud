import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { PermissionLevel } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import type { PulseBase, PulseSource, PulseSourceScrape } from "../../contracts";
import type { Overview } from "../../overview-contracts";
import type { DashboardSnapshot } from "./dashboard-client";
import type { WorkspaceRouteState } from "./routes";
import type { SavedQuery, SqlClientError, SqlLimits } from "./sql-client";

export type { WorkspaceView } from "./routes";
export type SourceCreateKind = "metrics" | "http_ingest";
export type GrantableLevel = Exclude<PermissionLevel, "none">;
export type CreateSourceInput = {
  kind: SourceCreateKind;
  name: string;
  endpointUrl?: string;
  bearerToken?: string;
  scrapeIntervalSeconds?: number;
  metricFilters?: string[];
  expectEverySeconds?: number | null;
  expectDailyBy?: string | null;
};
export type PulseWorkspaceProps = {
  initialBases: PulseBase[];
  initialBaseId: string;
  initialRouteState: WorkspaceRouteState;
  initialSources: PulseSource[];
  initialSettings?: { maxRawRetentionDays: number; admins: string[] };
  initialPermissions?: { write: boolean; admin: boolean };
  initialOverview?: { data: Overview | null; error: { code: string; message: string } | null };
  initialDashboards?: DashboardSnapshot;
  initialSql?: { limits: SqlLimits | null; query: SavedQuery | null; error: { code: string; details: SqlClientError["details"] } | null };
  initialSourceScrapes: Record<string, PulseSourceScrape[]>;
  initialSourceApiKeys: Record<string, ResourceApiKey[]>;
  initialQueryCoverage: { bases: boolean; baseData: boolean; sourceDetail: boolean };
  initialDateConfig: DateContext;
  initialNow: string;
  initialOrigin: string;
};
