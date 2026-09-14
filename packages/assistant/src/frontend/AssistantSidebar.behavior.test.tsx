import { expect, test } from "bun:test";
import type { AiConversation } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const conversation = (id: string, title: string, projectId: string | null): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null, isDone: false, lastUsedAt: "2026-09-14T00:00:00.000Z", archivedAt: null,
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
  const pending = new Promise<boolean>(resolve => { finish = resolve; });
  const [project, setProject] = createSignal<string | null>(null);
  const [view, setView] = createSignal<"chat" | "apps" | "all">("chat");
  let opens = 0;
  let transitions = 0;
  Object.defineProperty(dom.document, "startViewTransition", { configurable: true, value: () => { transitions++; } });
  const dispose = render(() => <AssistantSidebar
    conversations={() => [conversation("first", "First", null), conversation("second", "Second", null)]}
    activeConversationId={selected}
    activeProjectId={project()}
    activeView={view()}
    onOpenConversation={id => { opens++; setSelected(id); return pending; }}
    live={live}
  />, dom.root);
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
