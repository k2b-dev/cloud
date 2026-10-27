import { afterEach, beforeEach, expect, jest, setSystemTime, spyOn, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { assistantApi } from "../api/client";

// Load once outside any test, so the cold Solid transform of the sidebar's source graph does not count against the
// 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { default: AssistantSidebar } = await import("./AssistantSidebar");
    const { createAssistantLiveHub } = await import("./assistant-live");
    return { AssistantSidebar, createAssistantLiveHub };
  } finally {
    dom.cleanup();
  }
};
const { AssistantSidebar, createAssistantLiveHub } = await load();

// The sidebar switches to the browser clock after mount, so the age sections must not depend on the day the suite runs.
const renderedAt = "2026-10-08T10:00:00.000Z";
beforeEach(() => setSystemTime(new Date(renderedAt)));
afterEach(() => setSystemTime());

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
  const live = createAssistantLiveHub();
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
        timeZone="UTC"
        renderedAt={renderedAt}
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

test("footer project popup and mobile group share search and creation; pinned chats lead the list under their heading", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const { registerGlobalSearchHost } = await import("@k2b/cloud/browser/testing");
  const { readWorkspaceNavigation } = await import("@k2b/cloud/browser/testing");
  const project = {
    id: "Proj01",
    shortId: "Proj01",
    name: "Work",
    description: "",
    icon: "ti ti-folders",
    instructions: "",
    defaultModel: null,
    permission: "read" as const,
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  let created = 0;
  const searches: unknown[] = [];
  const release = registerGlobalSearchHost((options) => searches.push(options));
  const live = createAssistantLiveHub();
  const dispose = render(
    () => (
      <AssistantSidebar
        timeZone="UTC"
        renderedAt={renderedAt}
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
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".assistant-chat-sidebar-item"));
    expect(rows.map((row) => row.querySelector(".k2b-app-workspace__sidebar-item-label-text")?.textContent)).toEqual([
      "Pinned work",
      "Normal",
    ]);
    // Flat rows: the title alone, without a context line for the project or the time.
    expect(body.querySelector('[data-variant="card"]')).toBeNull();
    expect(body.querySelector(".k2b-app-workspace__sidebar-item-context")).toBeNull();
    const headings = Array.from(body.querySelectorAll("h2")).map((heading) => heading.textContent);
    expect(headings[0]).toBe("Pinned");
    expect(headings).not.toContain("Chats");
    const footer = dom.root.querySelector<HTMLElement>('footer[data-sidebar-mode="expanded"]')!;
    const panel = footer.querySelector<HTMLElement>('[role="dialog"][aria-label="Projects"]')!;
    const projects = footer.querySelector<HTMLButtonElement>(`button[aria-controls="${panel.id}"]`)!;
    // Happy DOM lacks the native popover implementation; expose its toggle events.
    const toggle = (newState: "open" | "closed") => {
      const event = new Event("toggle");
      Object.defineProperty(event, "newState", { value: newState });
      panel.dispatchEvent(event);
    };
    let closes = 0;
    panel.showPopover = () => toggle("open");
    panel.hidePopover = () => {
      closes++;
      toggle("closed");
    };
    projects.click();
    panel.querySelector<HTMLButtonElement>('[aria-label="Search Projects…"]')!.click();
    expect(searches).toEqual([
      { query: "", scope: { appId: "assistant", tag: "assistant-project", label: "Projects", icon: "ti ti-folders" } },
    ]);
    projects.click();
    panel.querySelector<HTMLButtonElement>('[aria-label="Create Project"]')!.click();
    expect(created).toBe(1);
    expect(closes).toBe(2);
    const mobile = readWorkspaceNavigation()!.navigation;
    const ids = mobile.items().map((item) => item.id);
    // The phone menu has the desktop list's sections: pinned first, then by last use.
    expect(ids.slice(2, 4)).toEqual(["section:pinned", "section:month"]);
    expect(
      mobile
        .items()
        .slice(2, 4)
        .map((section) => [section.label, section.children?.map((chat) => chat.id)]),
    ).toEqual([
      ["Pinned", ["chat:pinned"]],
      ["Previous 30 days", ["chat:normal"]],
    ]);
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

test("Done keeps its row through live updates, confirms success, then fades without blocking", async () => {
  const dom = createDomTestHarness();
  const live = createAssistantLiveHub();
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
    () => (
      <AssistantSidebar
        timeZone="UTC"
        renderedAt={renderedAt}
        conversations={items}
        live={live}
        onConversationUpdated={(item) => setItems([item])}
      />
    ),
    dom.root,
  );
  delegateEvents(["click"]);
  // Open chats, not the collapsed Done section that receives the chat afterwards.
  const card = () =>
    dom.root.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-section:not([data-collapsible]) .assistant-chat-sidebar-item");
  try {
    expect(card()?.querySelector('.assistant-chat-marker[title="Active schedule"]')).not.toBeNull();
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
    dom.cleanup();
  }
});

test("failed Done request leaves the chat available and clears its pending feedback", async () => {
  const dom = createDomTestHarness();
  const live = createAssistantLiveHub();
  const save = spyOn(assistantApi, "setConversationDone").mockRejectedValue(new Error("Offline"));
  const dispose = render(
    () => (
      <AssistantSidebar
        timeZone="UTC"
        renderedAt={renderedAt}
        conversations={() => [conversation("fail", "Keep this", null)]}
        live={live}
      />
    ),
    dom.root,
  );
  delegateEvents(["click"]);
  try {
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Mark chat done"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const card = dom.root.querySelector(".k2b-app-workspace__sidebar-section:not([data-collapsible]) .assistant-chat-sidebar-item");
    expect(card).not.toBeNull();
    expect(card?.classList.contains("assistant-chat-sidebar-item--saving")).toBe(false);
    expect(card?.querySelector<HTMLButtonElement>('[aria-label="Mark chat done"]')?.disabled).toBe(false);
  } finally {
    dispose();
    save.mockRestore();
    dom.cleanup();
  }
});

// Before any test reads live counts: the browser keeps the last read count for the whole page.
test("the server's approvals count renders the row from the first paint", async () => {
  const dom = createDomTestHarness();
  const live = createAssistantLiveHub();
  const dispose = render(
    () => (
      <AssistantSidebar
        timeZone="UTC"
        renderedAt={renderedAt}
        conversations={() => [conversation("first", "First", null)]}
        pendingApprovals={3}
        live={live}
      />
    ),
    dom.root,
  );
  try {
    const row = dom.root.querySelector<HTMLAnchorElement>('footer[data-sidebar-mode="expanded"] a[href="/app/assistant?approvals=1"]');
    expect(row?.querySelector(".k2b-app-workspace__sidebar-status-count")?.textContent).toBe("3");
    expect(row?.textContent).toContain("3 waiting");
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("the Approvals row sits above Studio while something waits and changes only on navigation", async () => {
  const dom = createDomTestHarness();
  const { readWorkspaceNavigation } = await import("@k2b/cloud/browser/testing");
  const { refreshAppBadges } = await import("@k2b/cloud/browser/app-badges");
  const { watchAppBadges } = await import("@k2b/cloud/ssr/app-badges");
  let counts = { total: 0, apps: {} as Record<string, number> };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json(counts), { preconnect: originalFetch.preconnect });
  const settle = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const live = createAssistantLiveHub();
  const [pending, setPending] = createSignal(0);
  const [selected, setSelected] = createSignal("first");
  let opened = 0;
  const dispose = render(
    () => (
      <AssistantSidebar
        timeZone="UTC"
        renderedAt={renderedAt}
        conversations={() => [conversation("first", "First", null), conversation("second", "Second", null)]}
        activeConversationId={selected}
        pendingApprovals={pending()}
        onOpenApprovals={() => {
          opened++;
        }}
        live={live}
      />
    ),
    dom.root,
  );
  delegateEvents(["click"]);
  const footer = () => dom.root.querySelector<HTMLElement>('footer[data-sidebar-mode="expanded"]')!;
  const row = () => footer().querySelector<HTMLAnchorElement>('a[href="/app/assistant?approvals=1"]');
  const mobileIds = () =>
    readWorkspaceNavigation()!
      .navigation.items()
      .map((item) => item.id);
  const stopBadges = watchAppBadges([]);
  try {
    // Rendered with nothing open: no row, on the desktop or on the phone.
    await settle();
    expect(row()).toBeNull();
    expect(mobileIds()).not.toContain("approvals");
    // A request that arrives while the person reads does not slide a row under the pointer.
    counts = { total: 2, apps: { assistant: 2 } };
    refreshAppBadges();
    await settle();
    expect(row()).toBeNull();
    setSelected("second");
    expect(row()).not.toBeNull();
    const labels = Array.from(footer().querySelectorAll(".k2b-app-workspace__sidebar-item-label-text")).map((label) => label.textContent);
    expect(labels.indexOf("Approvals")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Approvals")).toBeLessThan(labels.indexOf("Studio"));
    expect(row()!.querySelector(".k2b-app-workspace__sidebar-status-count")?.textContent).toBe("2");
    const ids = mobileIds();
    expect(ids.indexOf("approvals")).toBeLessThan(ids.indexOf("apps"));
    expect(
      readWorkspaceNavigation()!
        .navigation.items()
        .find((item) => item.id === "approvals")?.badge,
    ).toBe(2);
    // The last request decided elsewhere: the row stays with a muted 0 until the person navigates.
    counts = { total: 0, apps: {} };
    refreshAppBadges();
    await settle();
    expect(row()).not.toBeNull();
    expect(row()!.querySelector('[data-waiting="zero"] .k2b-app-workspace__sidebar-status-count')?.textContent).toBe("0");
    // Modified clicks keep the link's own behavior, such as a new tab; a plain click opens the view in place.
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
      row()!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(opened).toBe(0);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    row()!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toBe(1);
    // Navigation removes it; once the browser has read a count, that count wins over the rendered one.
    setPending(1);
    setSelected("first");
    expect(row()).toBeNull();
  } finally {
    stopBadges();
    globalThis.fetch = originalFetch;
    dispose();
    dom.cleanup();
  }
});
