import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import type { SpaceDetail, SpaceWormhole } from "@/contracts";
import type { SpaceUserSettings } from "../settings/SpaceSettingsStore";

export type SpaceEditPanelProps = {
  space: SpaceDetail;
  baseUrl: string;
  initialSettings: SpaceUserSettings;
  onClose?: () => void;
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  accessEntries?: AccessEntry[];
  apiKeys?: ResourceApiKey[];
  wormholes?: SpaceWormhole[];
  isAdmin?: boolean;
  canWrite?: boolean;
};
