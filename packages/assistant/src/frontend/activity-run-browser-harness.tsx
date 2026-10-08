import { openAssistantTaskRun } from "./AssistantActivitiesDialog";
import { createAssistantLiveHub } from "./assistant-live";

// The run of a finished background task, opened as from the activity list; the test serves its result.
void openAssistantTaskRun("task01", "run001", createAssistantLiveHub());
