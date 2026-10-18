import type { AiConversation } from "@k2b/cloud/ai";
import { render } from "solid-js/web";
import { openAssistantConversationEditor } from "./AssistantConversationEditor";
import { AssistantTaskDetail } from "./AssistantTasksDialog";
import { AssistantLiveProvider, createAssistantLiveHub } from "./assistant-live";

// `?view=archive` opens the chat settings of a chat with routines; otherwise the routine `task-<code>` opens as its tab
// does. The test serves the data and sets the page language.
const params = new URLSearchParams(location.search);
const conversation: AiConversation = {
  id: "chat01",
  shortId: "chat01",
  title: "Rechnungen",
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-10-16T08:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-16T08:00:00.000Z",
  draft: { content: [], revision: 0, updatedAt: null },
};

if (params.get("view") === "archive") void openAssistantConversationEditor(conversation);
else
  render(
    () => (
      <AssistantLiveProvider value={createAssistantLiveHub()}>
        <div style={{ display: "flex", height: "100vh" }}>
          <AssistantTaskDetail taskId={`task-${params.get("code") ?? "failed"}`} onOpenRun={() => undefined} onEdit={() => undefined} />
        </div>
      </AssistantLiveProvider>
    ),
    document.body,
  );
