import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { PermissionLevel } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import type { PulseBase, PulseSource, PulseSourceScrape } from "../../contracts";
import type { SavedQuery, SqlLimits, SqlClientError } from "./sql-client";
import type { WorkspaceRouteState } from "./routes";

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
};
export type PulseWorkspaceProps = {
  initialBases: PulseBase[];
  initialBaseId: string;
  initialRouteState: WorkspaceRouteState;
  initialSources: PulseSource[];
  initialSql?: { limits: SqlLimits | null; query: SavedQuery | null; error: { code: string; details: SqlClientError["details"] } | null };
  initialSourceScrapes: Record<string, PulseSourceScrape[]>;
  initialSourceApiKeys: Record<string, ResourceApiKey[]>;
  initialQueryCoverage: { bases: boolean; baseData: boolean; sourceDetail: boolean };
  initialDateConfig: DateContext;
  initialNow: string;
  initialOrigin: string;
};
