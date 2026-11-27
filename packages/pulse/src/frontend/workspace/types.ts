import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { PermissionLevel } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import type { FetchMinute, PulseBase, PulseSource, PulseSourceScrape, SourceAlert, SourceEvent, SourceFigures } from "../../contracts";
import type { BaseAttention } from "../../service/base-attention";
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
  /** On Sources: fired alerts and the data store state, read on the server. */
  initialAttention?: BaseAttention;
  initialSql?: { limits: SqlLimits | null; query: SavedQuery | null; error: { code: string; details: SqlClientError["details"] } | null };
  initialSourceScrapes: Record<string, PulseSourceScrape[]>;
  /** The open metrics source's last hour per minute, read on the server. */
  initialSourceMinutes?: Record<string, FetchMinute[]>;
  /** The open source's alert rules, read on the server. */
  initialSourceAlerts?: Record<string, SourceAlert[]>;
  /** The open source's history, read on the server. */
  initialSourceHistory?: Record<string, SourceEvent[]>;
  initialSourceApiKeys: Record<string, ResourceApiKey[]>;
  initialQueryCoverage: { bases: boolean; baseData: boolean; sourceDetail: boolean };
  /** The figures of all sources of the base, read on the server for the sources view; null when they could not be read. */
  initialFigures?: SourceFigures | null;
  initialDateConfig: DateContext;
  initialNow: string;
  initialOrigin: string;
  /** An old dashboard link led here (`?notice=dashboards-removed`); the page says what happened once. */
  initialNotice?: "dashboards-removed";
};
