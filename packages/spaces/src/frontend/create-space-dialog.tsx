import { apiClient } from "../api/client";
import type { Space } from "../contracts";
import type { ViewType } from "./[id]/_components/settings/SpaceSettingsStore";
import { readResponseError } from "./lib/response";
import type { overviewMessages } from "./overview-messages";

export type SpaceStarter = {
  id: "blank" | "tasks" | "calendar" | "project";
  name: string;
  description: string;
  icon: string;
  color: string;
};
type SpaceDraft = { name: string; description: string; color: string; starter: SpaceStarter };
export const starterView: Record<SpaceStarter["id"], ViewType> = {
  blank: "list",
  tasks: "kanban",
  calendar: "calendar",
  project: "table",
};

/** Creates a Space with its starter; a refusal throws the server's reason. */
export const createSpaceRequest = async (draft: SpaceDraft, failed: string): Promise<Space> => {
  const response = await apiClient.index.$post({
    json: { name: draft.name, description: draft.description || undefined, color: draft.color, starter: draft.starter.id },
  });
  if (!response.ok) throw new Error(await readResponseError(response, failed));
  return response.json();
};
export const spaceStarters = (t: ReturnType<typeof overviewMessages.resolve>["t"]): SpaceStarter[] => [
  { id: "blank", name: t.blankSpace, description: t.blankSpaceDescription, icon: "ti ti-plus", color: "#3b82f6" },
  { id: "tasks", name: t.taskBoard, description: t.taskBoardDescription, icon: "ti ti-list-check", color: "#3b82f6" },
  { id: "calendar", name: t.eventCalendar, description: t.eventCalendarDescription, icon: "ti ti-calendar-event", color: "#8b5cf6" },
  { id: "project", name: t.projectTracker, description: t.projectTrackerDescription, icon: "ti ti-flag", color: "#10b981" },
];
