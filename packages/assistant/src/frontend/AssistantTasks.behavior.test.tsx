import { expect, spyOn, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { AssistantLiveProvider, createAssistantLiveInvalidationHub } from "./assistant-live";
import type { AiChatTaskView, AiChatTaskOccurrenceView } from "@k2b/cloud/ai";
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const task: AiChatTaskView = {
  id: "task01",
  chatId: "chat01",
  chatTitle: "Chat",
  prompt: "Weekly overview: read my calendar",
  grants: [],
  schedule: { kind: "cron", cron: "30 9 * * 1" },
  timezone: "Europe/Berlin",
  state: "active",
  nextRunAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  lastError: null,
  createdAt: "2026-09-20T09:00:00Z",
  updatedAt: "2026-09-20T09:00:00Z",
};
test("task list opens the selected task without a manual form; details expose access and edit intent", async () => {
  const dom = createDomTestHarness();
  const { AssistantTaskDetail, AssistantTasksView } = await import("./AssistantTasksDialog");
  const { toast } = await import("@k2b/ui");
  const confirmation = spyOn(toast, "success").mockReturnValue({ dismiss() {}, update() {} });
  const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined, delayMs: 1 });
  let occurrences: AiChatTaskOccurrenceView[] = [];
  let selected = "",
    edit: { id: string; repair: boolean } | undefined;
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) =>
        Response.json(
          String(input).includes("tasks?")
            ? [task]
            : {
                task,
                occurrences,
                permissions: [
                  {
                    title: "Read calendar",
                    app: "Spaces",
                    icon: "ti ti-calendar",
                    mode: "Read only",
                    scope: "All calendars you can access",
                  },
                ],
              },
        ),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  let dispose = render(
    () => (
      <AssistantLiveProvider value={live}>
        <AssistantTasksView
          chatId="chat01"
          onOpenRun={() => {}}
          onOpenTask={(task) => {
            selected = task.id;
          }}
        />
      </AssistantLiveProvider>
    ),
    dom.root,
  );
  try {
    await tick();
    expect(dom.root.querySelector("form")).toBeNull();
    expect(dom.root.textContent).toContain("Mondays");
    expect(dom.root.textContent).toContain("Next run");
    expect(dom.root.textContent).toContain("in 3 days");
    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    expect(selected).toBe("task01");
    dispose();
    dispose = render(
      () => (
        <AssistantLiveProvider value={live}>
          <AssistantTaskDetail
            taskId="task01"
            onOpenRun={() => {}}
            onEdit={(task, repair) => {
              edit = { id: task.id, repair };
            }}
          />
        </AssistantLiveProvider>
      ),
      dom.root,
    );
    await tick();
    expect(dom.root.textContent).toContain("No occurrences yet");
    const button = (label: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label)!;
    button("Access").click();
    await tick();
    expect(dom.root.textContent).toContain("All calendars you can access");
    occurrences = [
      {
        id: "run001",
        taskId: task.id,
        scheduledFor: task.createdAt,
        trigger: "manual",
        state: "running",
        error: null,
        resultText: null,
        createdAt: task.createdAt,
        startedAt: task.createdAt,
        completedAt: null,
      },
    ];
    live.scheduleScopeRefresh();
    await tick();
    await tick();
    expect(dom.root.textContent).toContain("Running");
    occurrences = [{ ...occurrences[0]!, state: "completed", resultText: "Calendar checked." }];
    live.scheduleScopeRefresh();
    await tick();
    await tick();
    button("Latest result").click();
    await tick();
    expect(dom.root.textContent).toContain("Calendar checked.");
    button("Adjust in chat").click();
    expect(edit).toEqual({ id: "task01", repair: false });
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.click();
    await tick();
    Array.from(dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes("Run now"))!.click();
    await tick(); await tick();
    expect(confirmation).toHaveBeenCalledWith("Task queued. The result will appear here and in the chat when it is ready.", { title: "Scheduled task" });
  } finally {
    dispose();
    fetchMock.mockRestore();
    confirmation.mockRestore();
    live.dispose();
    dom.cleanup();
  }
});
