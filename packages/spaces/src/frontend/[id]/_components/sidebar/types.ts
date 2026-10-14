import type { SpaceColumn, SpaceDetail, SpaceTag } from "@/contracts";
import type { SpaceUserSettings, ViewType } from "../settings/SpaceSettingsStore";

/**
 * Shared context object for space-related components.
 * Bundles all common props to reduce prop drilling.
 */
export type SpaceContext = {
  userId?: string;
  /** The space detail object */
  space: SpaceDetail;
  /** Columns of the space */
  columns: SpaceColumn[];
  /** Tags of the space */
  tags: SpaceTag[];
  /** Current effective view (from query param or cookie default) */
  currentView: ViewType;
  /** Whether current values are overridden by query params */
  hasOverride: boolean;
  /** User settings for this space (cookie defaults) */
  settings: SpaceUserSettings;
  /** Current query string without leading question mark */
  query: string;
  /** Whether the current user may mutate this space and its items */
  canWrite: boolean;
};
