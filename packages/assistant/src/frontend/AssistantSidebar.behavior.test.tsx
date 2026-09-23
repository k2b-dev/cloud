import { expect, jest, spyOn, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { assistantApi } from "../api/client";

const conversation = (id: string, title: string, projectId: string | null): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: "2026-09-14T00:00:00.000Z",
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "user123",
  createdAt: "2026-08-12T08:00:00.000Z",
  updatedAt: "2026-08-12T08:00:00.000Z",
});

test("chat clicks select immediately while loading, preserve native modifiers and ignore stale completions", async () => {
  const dom = createDomTestHarness();
  const { default: AssistantSidebar } = await import("./AssistantSidebar");
  const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
  const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
  const [selected, setSelected] = createSignal("first");
  let finish: (opened: boolean) => void = () => {};
  const pending = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const [project, setProject] = createSignal<string | null>(null);
  const [view, setView] = createSignal<"chat" | "apps" | "all">("chat");
  let opens = 0;
  let transitions = 0;
  Object.defineProperty(dom.document, "startViewTransition", {
    configurable: true,
    value: () => {
      transitions++;
    },
  });
  const dispose = render(
    () => (
      <AssistantSidebar
        conversations={() => [conversation("first", "First", null), conversation("second", "Second", null)]}
        activeConversationId={selected}
        activeProjectId={project()}
        activeView={view()}
        onOpenConversation={(id) => {
          opens++;
          setSelected(id);
          return pending;
        }}
        live={live}
      />
    ),
    dom.root,
  );
  delegateEvents(["click"]);
  try {
    const link = dom.root.querySelector<HTMLAnchorElement>('a[href="/app/assistant?conversation=second"]')!;
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(opens).toBe(0);
    const href = dom.window.location.href;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opens).toBe(1);
    expect(selected()).toBe("second");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(transitions).toBe(0);
    finish(false);
    await pending;
    await Promise.resolve();
    expect(dom.window.location.href).toBe(href);
    setProject("project123");
    expect(link.getAttribute("aria-current")).not.toBe("page");
    setProject(null);
    expect(link.getAttribute("aria-current")).toBe("page");
    for (const destination of ["apps", "all"] as const) {
      setView(destination);
      expect(link.getAttribute("aria-current")).not.toBe("page");
    }
    setView("chat");
    setProject("project123");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opens).toBe(2);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("footer project popup and mobile group share search and creation; pinned chats lead a heading-free list", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { default: AssistantSidebar } = await import("./AssistantSidebar");
  const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
  const { registerGlobalSearchHost } = await import("@k2b/cloud/browser/testing");
  const { readWorkspaceNavigation } = await import("@k2b/cloud/browser/testing");
  const project = {
    id: "Proj01",
    shortId: "Proj01",
    name: "Work",
    description: "",
    icon: "ti ti-folders",
    instructions: "",
    defaultModelProfileId: null,
    permission: "read" as const,
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  let created = 0;
  const searches: unknown[] = [];
  const release = registerGlobalSearchHost((options) => searches.push(options));
  const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
  const dispose = render(
    () => (
      <AssistantSidebar
        projects={[project]}
        live={live}
        onCreateProject={() => {
          created++;
        }}
        conversations={() => [
          conversation("normal", "Normal", null),
          { ...conversation("pinned", "Pinned work", project.id), pinnedAt: "2026-09-16T00:00:00Z" },
        ]}
      />
    ),
    dom.root,
  );
  try {
    const body = dom.root.querySelector<HTMLElement>('.k2b-app-workspace__sidebar-body[data-sidebar-mode="expanded"]')!;
    const cards = Array.from(body.querySelectorAll<HTMLElement>('[data-variant="card"]'));
    expect(cards.map((card) => card.querySelector(".k2b-app-workspace__sidebar-item-label-text")?.textContent)).toEqual([
      "Pinned work",
      "Normal",
    ]);
    expect(cards[0]!.querySelector(".k2b-app-workspace__sidebar-item-context-label .ti-pin.text-accent")).not.toBeNull();
    expect(cards[0]!.querySelector(".k2b-app-workspace__sidebar-item-context-label")?.textContent).toContain("Work");
    expect(cards[0]!.querySelector(".k2b-app-workspace__sidebar-item-context-meta .ti-pin")).toBeNull();
    expect(Array.from(body.querySelectorAll("h2")).map((heading) => heading.textContent)).not.toContain("Chats");
    const footer = dom.root.querySelector<HTMLElement>('footer[data-sidebar-mode="expanded"]')!;
    const panel = footer.querySelector<HTMLElement>('[role="dialog"][aria-label="Projects"]')!;
    let closes = 0;
    panel.hidePopover = () => {
      closes++;
    };
    panel.querySelector<HTMLButtonElement>('[aria-label="Search Projects…"]')!.click();
    expect(searches).toEqual([
      { query: "", scope: { appId: "assistant", tag: "assistant-project", label: "Projects", icon: "ti ti-folders" } },
    ]);
    panel.querySelector<HTMLButtonElement>('[aria-label="Create Project"]')!.click();
    expect(created).toBe(1);
    expect(closes).toBe(2);
    const mobile = readWorkspaceNavigation()!.navigation;
    const ids = mobile.items().map((item) => item.id);
    expect(ids.slice(2, 4)).toEqual(["chat:pinned", "chat:normal"]);
    expect(ids.slice(-4)).toEqual(["apps", "projects", "activities", "preferences"]);
    expect(ids).not.toContain("pinned");
    expect(ids).not.toContain("chats");
    expect(mobile.items().find((item) => item.id === "projects")?.defaultExpanded).toBe(false);
    const studio = mobile.items().find((item) => item.id === "apps");
    expect(studio?.action).toBe("apps");
    expect(studio?.href).toBeUndefined();
    expect(studio?.children).toBeUndefined();
    await mobile.activate("search-projects");
    await mobile.activate("new-project");
    expect(searches).toHaveLength(2);
    expect(created).toBe(2);
  } finally {
    release();
    dispose();
    dom.cleanup();
  }
});

test("Done keeps its card through live updates, confirms success, then fades without blocking", async () => {
  const dom = createDomTestHarness();
  const { default: AssistantSidebar } = await import("./AssistantSidebar");
  const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
  const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
  const original = { ...conversation("finish", "Finish this", null), hasActiveSchedule: true };
  const completed = { ...original, isDone: true, done: true };
  const [items, setItems] = createSignal<AiConversation[]>([original]);
  let resolveSave: (value: AiConversation) => void = () => {};
  const save = spyOn(assistantApi, "setConversationDone").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
  );
  const dispose = render(
    () => <AssistantSidebar conversations={items} live={live} onConversationUpdated={(item) => setItems([item])} />,
    dom.root,
  );
  delegateEvents(["click"]);
  const card = () => dom.root.querySelector<HTMLElement>('.assistant-chat-sidebar-item[data-variant="card"]');
  try {
    expect(card()?.querySelector('[aria-label="Active schedule"]')).not.toBeNull();
    card()!.querySelector<HTMLButtonElement>('[aria-label="Mark chat done"]')!.click();
    expect(card()?.classList.contains("assistant-chat-sidebar-item--saving")).toBe(true);
    setItems([completed]);
    expect(card()).not.toBeNull();
    // The confirm (450 ms) and fade (150 ms) phases are timer-driven; fake timers keep a stalled runner from skipping one.
    jest.useFakeTimers();
    resolveSave(completed);
    await save.mock.results[0]!.value;
    expect(card()?.classList.contains("assistant-chat-sidebar-item--confirmed")).toBe(true);
    expect(card()?.textContent).toContain("Done");
    jest.advanceTimersByTime(449);
    expect(card()?.classList.contains("assistant-chat-sidebar-item--confirmed")).toBe(true);
    jest.advanceTimersByTime(1);
    expect(card()?.classList.contains("assistant-chat-sidebar-item--leaving")).toBe(true);
    jest.advanceTimersByTime(150);
    expect(card()).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
    dispose();
    save.mockRestore();
    live.dispose();
    dom.cleanup();
  }
});

test("failed Done request leaves the chat available and clears its pending feedback", async () => {
  const dom = createDomTestHarness();
  const { default: AssistantSidebar } = await import("./AssistantSidebar");
  const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
  const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
  const save = spyOn(assistantApi, "setConversationDone").mockRejectedValue(new Error("Offline"));
  const dispose = render(() => <AssistantSidebar conversations={() => [conversation("fail", "Keep this", null)]} live={live} />, dom.root);
  delegateEvents(["click"]);
  try {
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Mark chat done"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const card = dom.root.querySelector('.assistant-chat-sidebar-item[data-variant="card"]');
    expect(card).not.toBeNull();
    expect(card?.classList.contains("assistant-chat-sidebar-item--saving")).toBe(false);
    expect(card?.querySelector<HTMLButtonElement>('[aria-label="Mark chat done"]')?.disabled).toBe(false);
  } finally {
    dispose();
    save.mockRestore();
    live.dispose();
    dom.cleanup();
  }
});
