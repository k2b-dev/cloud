import { expect, spyOn, test } from "bun:test";
import type { AiChatTaskOccurrenceView, AiChatTaskView, AiStoredMessage } from "@k2b/cloud/ai";
import { createDomTestHarness } from "../../../ui/test/dom";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("global task dialogs provide live context through activity, run detail and task management", async () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  const { dialogCore } = await import("@k2b/ui");
  const { openAssistantActivities, openAssistantTaskRun } = await import("./AssistantActivitiesDialog");
  const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
  const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
  const task: AiChatTaskView = {
    id: "task01",
    chatId: "chat01",
    chatTitle: "Morning chat",
    grants: [],
    prompt: "Changed task prompt",
    schedule: { kind: "cron", cron: "0 9 * * *" },
    timezone: "UTC",
    state: "active",
    lastError: null,
    createdAt: "2026-09-20T09:00:00Z",
    updatedAt: "2026-09-20T09:00:00Z",
  };
  const occurrence: AiChatTaskOccurrenceView = {
    id: "run001",
    taskId: task.id,
    scheduledFor: "2026-09-20T09:00:00Z",
    trigger: "scheduled",
    state: "completed",
    error: null,
    resultText: "Your morning overview is ready.",
    createdAt: "2026-09-20T09:00:00Z",
    startedAt: null,
    completedAt: null,
  };
  const message: AiStoredMessage = {
    id: "message",
    shortId: "msg001",
    conversationId: "chat01",
    seq: 1,
    kind: "message",
    message: { role: "user", content: [{ type: "text", text: "Original run instruction" }] },
    loopId: "run001",
    modelProfileId: null,
    providerModel: null,
    usage: null,
    stopReason: null,
    loopAggregate: null,
    loopDoneReason: null,
    compactedAt: null,
    meta: null,
    createdAt: "2026-09-20T09:00:00Z",
  };
  const requests: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/occurrences/")) return Response.json({ task, occurrence, messages: [message] });
        if (url.includes("/activities?"))
          return Response.json({ items: [{ task, occurrence, chatTitle: task.chatTitle, unread: true }], hasMore: false });
        if (url.endsWith("/tasks/status")) return Response.json({ timezone: "UTC" });
        if (url.includes("/tasks?")) return Response.json([task]);
        return Response.json({ task, occurrences: [occurrence] });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    // Invoke without a Solid owner, as toolbar/event handlers do.
    const result = openAssistantTaskRun(task.id, occurrence.id, live);
    await tick();
    expect(dom.document.body.textContent).toContain("Original run instruction");
    expect(dom.document.body.textContent).not.toContain("Changed task prompt");
    const manage = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Manage task"));
    expect(manage).toBeDefined();
    const history = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Run history");
    expect(history).toBeDefined();
    history!.click();
    await tick();
    expect(dom.document.querySelector(".assistant-activity-transcript")).not.toBeNull();
    expect(dom.document.body.textContent).not.toContain('"role":');
    dialogCore.close();
    await tick();
    dialogCore.close();
    await result;
    const activities = openAssistantActivities(live);
    await tick();
    const activity = Array.from(dom.document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Changed task prompt"),
    );
    expect(activity?.classList.contains("k2b-button")).toBe(true);
    activity!.click();
    await tick();
    expect(dom.document.body.textContent).toContain("Original run instruction");
    dialogCore.close();
    await tick();
    dialogCore.close();
    await activities;
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    await tick();
    fetchMock.mockRestore();
    live.dispose();
    dom.cleanup();
  }
});
