import { expect, spyOn, test } from "bun:test";
import type { AiChatTaskOccurrenceView, AiChatTaskView, AiStoredMessage } from "@k2b/cloud/ai";
import { createDomTestHarness } from "../../../ui/test/dom";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

test("global task dialogs provide live context through activity, run detail and task management", async () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  const { dialogCore } = await import("@k2b/ui");
  const { openAssistantActivities, openAssistantTaskRun } = await import("./AssistantActivitiesDialog");
  const { createAssistantLiveHub } = await import("./assistant-live");
  const live = createAssistantLiveHub();
  const task: AiChatTaskView = {
    id: "task01",
    chatId: "chat01",
    chatTitle: "Morning chat",
    grants: [],
    title: "Changed task prompt",
    name: "Changed task prompt",
    reason: null,
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
    message: { role: "user", content: [{ type: "text", text: "Routine task01 (2026-09-20T08:00:00Z):\n\nOriginal run instruction" }] },
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
  // The run presented a table view; its transcript loads the file from the task's chat.
  const viewPath = "/views/morning-totals-1a2b3c4d.view.json";
  const stored = (seq: number, content: AiStoredMessage["message"]): AiStoredMessage => ({
    ...message,
    id: `message-${seq}`,
    shortId: `msg00${seq}`,
    seq,
    message: content,
  });
  const delivering = stored(2, {
    role: "assistant",
    content: [{ type: "tool_call", id: "present-view", name: "present", args: { path: viewPath } }],
  });
  const delivered = stored(3, {
    role: "tool_result",
    callId: "present-view",
    name: "present",
    result: { path: viewPath, view: { view: "table", title: "Morning totals", rows: 1, columns: 1, footer: false } },
    isError: false,
  });
  const view = { view: "table", title: "Morning totals", columns: [{ id: "item", type: "text" }], rows: [{ item: "Coffee beans" }] };
  const requests: string[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/occurrences/")) return Response.json({ task, occurrence, messages: [message, delivering, delivered] });
        if (url.startsWith(`/api/ai/conversations/${task.chatId}/files/content?`))
          return Response.json(view, { headers: { "X-Cloud-Ai-File-Origin": "assistant" } });
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
    expect(dom.document.body.textContent).not.toContain("Routine task01");
    expect(dom.document.body.textContent).not.toContain("Changed task prompt");
    const manage = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.includes("Manage routine"));
    expect(manage).toBeDefined();
    const history = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Run history");
    expect(history).toBeDefined();
    history!.click();
    await tick();
    expect(dom.document.querySelector(".assistant-activity-transcript")).not.toBeNull();
    expect(dom.document.body.textContent).not.toContain('"role":');
    await tick();
    expect(requests).toContain(`/api/ai/conversations/${task.chatId}/files/content?path=${encodeURIComponent(viewPath)}`);
    expect(dom.document.querySelector(`[data-view-path="${viewPath}"]`)?.textContent).toContain("Coffee beans");
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
    dom.cleanup();
  }
});

test("an expired run or run history explains that its result stays in the chat, also when it expires while open", async () => {
  const dom = createDomTestHarness();
  dom.root.className = "k2b-ui";
  const { dialogCore } = await import("@k2b/ui");
  const { openAssistantTaskRun } = await import("./AssistantActivitiesDialog");
  const { createAssistantLiveHub } = await import("./assistant-live");
  const task: AiChatTaskView = {
    id: "task01",
    chatId: "chat01",
    chatTitle: "Morning chat",
    grants: [],
    title: "Morning overview",
    name: "Morning overview",
    reason: null,
    prompt: "Morning overview",
    schedule: { kind: "cron", cron: "0 9 * * *" },
    timezone: "UTC",
    state: "active",
    lastError: null,
    createdAt: "2026-06-20T09:00:00Z",
    updatedAt: "2026-06-20T09:00:00Z",
  };
  const occurrence: AiChatTaskOccurrenceView = {
    id: "run001",
    taskId: task.id,
    scheduledFor: "2026-06-20T09:00:00Z",
    trigger: "scheduled",
    state: "completed",
    error: null,
    resultText: "Your morning overview is ready.",
    createdAt: "2026-06-20T09:00:00Z",
    startedAt: null,
    completedAt: null,
  };
  let removed = false;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () =>
        removed
          ? Response.json({ error: { code: "NOT_FOUND", message: "Task run not found" } }, { status: 404 })
          : Response.json({ task, occurrence, messages: [] }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const unavailable = () => {
    const placeholder = dom.document.querySelector(".k2b-placeholder");
    expect(placeholder?.getAttribute("data-state")).toBe("empty");
    expect(placeholder?.textContent).toContain("This run is no longer available");
    expect(placeholder?.textContent).toContain("Its result stays in the chat.");
    expect(dom.document.body.textContent).not.toContain("Could not load background activity");
    expect(dom.document.body.textContent).not.toContain("Your morning overview is ready.");
    expect(dom.document.querySelector(".assistant-activity-dialog__actions")).toBeNull();
  };
  try {
    // Expires while the run is open: the live refresh answers 404 and must replace the stale run.
    const live = createAssistantLiveHub();
    const open = openAssistantTaskRun(task.id, occurrence.id, live);
    await tick();
    expect(dom.document.body.textContent).toContain("Your morning overview is ready.");
    removed = true;
    await live.resync().catch(() => undefined);
    await tick();
    unavailable();
    dialogCore.close();
    await open;
    // Opened after removal, for example from the result message in the chat.
    const later = openAssistantTaskRun(task.id, occurrence.id, createAssistantLiveHub());
    await tick();
    unavailable();
    dialogCore.close();
    await later;
    // A one-off task's slot run outlives its transcript: the history explains the gap instead of staying blank.
    removed = false;
    void openAssistantTaskRun(task.id, occurrence.id, createAssistantLiveHub());
    await tick();
    const history = [...dom.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Run history"));
    history?.click();
    await tick();
    const historyPlaceholder = [...dom.document.querySelectorAll(".k2b-placeholder")].find((item) =>
      item.textContent?.includes("No run history"),
    );
    expect(historyPlaceholder?.textContent).toContain("Run details are kept for 90 days after a run finishes.");
  } finally {
    while (dialogCore.isOpen()) dialogCore.close();
    await tick();
    fetchMock.mockRestore();
    dom.cleanup();
  }
});
