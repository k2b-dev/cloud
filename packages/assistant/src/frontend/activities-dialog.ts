import type { AssistantLiveHub } from "./assistant-live";
import { lazyAction } from "./lazy-action";

/** The activities dialog, loaded when someone opens it; one dialog at a time. */
const activities = lazyAction(() => import("./AssistantActivitiesDialog"));

export const openActivities = (live: AssistantLiveHub, locale: string) =>
  activities(locale, (module) => module.openAssistantActivities(live));

export const openTaskRun = (taskId: string, occurrenceId: string, live: AssistantLiveHub, locale: string) =>
  activities(locale, (module) => module.openAssistantTaskRun(taskId, occurrenceId, live));
