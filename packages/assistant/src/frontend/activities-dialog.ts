import { toast } from "@k2b/ui";
import type { AssistantLiveHub } from "./assistant-live";
import { assistantMessages } from "./messages";

/**
 * The activities dialog loads when someone opens it, so it stays out of the workspace bundle. A chunk that cannot load
 * says so instead of doing nothing; errors of the dialog itself stay the dialog's.
 */
const dialog = (locale: string) =>
  import("./AssistantActivitiesDialog").catch(() => {
    toast.error(assistantMessages.resolve([locale]).t.chatActionFailed);
    return null;
  });

export const openActivities = async (live: AssistantLiveHub, locale: string) => (await dialog(locale))?.openAssistantActivities(live);

export const openTaskRun = async (taskId: string, occurrenceId: string, live: AssistantLiveHub, locale: string) =>
  (await dialog(locale))?.openAssistantTaskRun(taskId, occurrenceId, live);
