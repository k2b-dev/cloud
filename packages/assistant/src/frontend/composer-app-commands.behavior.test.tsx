import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { AiConversation, AiProject, AiPublicModelProfile } from "@k2b/cloud/ai";
import type { CloudComposerCommand } from "@k2b/cloud/browser/composer-insert";
import { batch } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const bootstrap = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const commandsModule = await import("@k2b/cloud/browser/commands");
const events: string[] = [];
const openCommand = mock(async (_id: string, _input: unknown, _options: { returnTo?: string }, _signal?: AbortSignal) => {
  events.push("open");
});
mock.module("@k2b/cloud/browser/commands", () => ({ ...commandsModule, openCommand }));
const { default: Workspace } = await import("./AssistantWorkspace.island");
bootstrap.cleanup();
const command: CloudComposerCommand = {
  id: "spaces.task.compose",
  appId: "spaces",
  appName: "Spaces",
  appIcon: "ti ti-layout-kanban",
  title: "Neue Aufgabe",
  description: "Eine Aufgabe öffnen.",
  icon: "ti ti-checkbox",
  keywords: ["task", "Aufgabe"],
  input: {},
};
const now = "2026-10-10T12:00:00.000Z";
const conversation: AiConversation = {
  id: "chat01",
  shortId: "chat01",
  title: "New chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: now,
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 4, updatedAt: null },
  createdByUserId: "user01",
  createdAt: now,
  updatedAt: now,
};
const project: AiProject = {
  id: "Proj01",
  shortId: "Proj01",
  name: "Summer fair",
  description: "",
  icon: "ti ti-tent",
  instructions: "",
  defaultModelProfileId: null,
  permission: "write",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const models: AiPublicModelProfile[] = [
  { id: "standard", label: "Standard", provider: "ollama", model: "standard", capabilities: ["streaming"], dataBoundary: "private" },
];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  openCommand.mockReset();
  openCommand.mockImplementation(async () => {
    events.push("open");
  });
  events.length = 0;
  setSystemTime();
});
const waitFor = async (condition: () => boolean, timeoutMs = 1_000) => {
  for (let i = 0; i < timeoutMs / 10; i++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition did not settle");
};
const mount = async (
  options: {
    conflict?: boolean;
    project?: boolean;
    newChat?: boolean;
    content?: AiConversation["draft"]["content"];
    saveGate?: Promise<void>;
    createGate?: Promise<void>;
    pendingApprovals?: number;
  } = {},
) => {
  setSystemTime(new Date(now));
  const initial = { ...conversation, draft: { ...conversation.draft, content: options.content ?? [] } };
  const dom = createDomTestHarness();
  cleanups.push(dom.cleanup);
  const path = options.project
    ? "/app/assistant?project=Proj01"
    : options.newChat
      ? "/app/assistant"
      : "/app/assistant?conversation=chat01";
  dom.window.history.replaceState(null, "", path);
  const opened = new WeakSet<HTMLElement>();
  const matches = HTMLElement.prototype.matches;
  Object.defineProperty(HTMLElement.prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
    },
  });
  HTMLElement.prototype.showPopover = function () {
    opened.add(this);
    this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
  };
  HTMLElement.prototype.hidePopover = function () {
    opened.delete(this);
    this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" }));
  };
  const shell = dom.document.createElement("script");
  shell.id = "cloud-shell-data";
  shell.textContent = JSON.stringify({ apps: [{ id: "spaces" }], appId: "assistant" });
  dom.document.body.append(shell);
  const saves: unknown[] = [],
    creates: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/capabilities/v1/catalog")
        return Response.json({
          protocolVersion: 2,
          apps: [
            {
              appId: "spaces",
              appName: "Spaces",
              appIcon: command.appIcon,
              appDescription: "Tasks",
              manifest: {
                protocolVersion: 2,
                appId: "spaces",
                manifestHash: "a".repeat(64),
                types: [],
                queries: [],
                actions: [],
                commands: [
                  {
                    localId: "task.compose",
                    title: command.title,
                    description: command.description,
                    icon: command.icon,
                    keywords: command.keywords,
                    inputSchema: { type: "object", properties: {}, additionalProperties: false },
                    path: "/app/spaces",
                  },
                ],
              },
            },
          ],
          page: { hasMore: false },
        });
      if (url.pathname === "/api/ai/conversations" && init?.method === "POST") {
        events.push("create");
        creates.push(JSON.parse(String(init.body)));
        await options.createGate;
        return Response.json({
          ...conversation,
          id: "new001",
          shortId: "new001",
          projectId: options.project ? project.id : null,
          draft: { content: [], revision: 0, updatedAt: null },
        });
      }
      if (url.pathname.endsWith("/draft") && init?.method === "PUT") {
        events.push("save");
        const body: { content: AiConversation["draft"]["content"]; expectedRevision: number } = JSON.parse(String(init.body));
        saves.push(body);
        await options.saveGate;
        return options.conflict
          ? Response.json({ message: "Draft conflict" }, { status: 409 })
          : Response.json({ content: body.content, revision: body.expectedRevision + 1, updatedAt: now });
      }
      if (url.pathname === "/api/approvals") return Response.json({ items: [], nextCursor: null, count: 0, elsewhere: 0 });
      if (url.pathname.endsWith("/stream") || url.pathname.endsWith("/live"))
        return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname.startsWith("/api/ai/skills")) return Response.json({ skills: [] });
      if (url.pathname === "/api/ai/tasks") return Response.json([]);
      if (url.pathname === "/api/ai/conversations/chat01")
        return Response.json({ conversation: initial, messages: [], hasMoreMessages: false, activeTurn: null, timeline: [] });
      return Response.json({ message: "unavailable" }, { status: 503 });
    },
    { preconnect: originalFetch.preconnect },
  );
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
  const active = !options.project && !options.newChat;
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <Workspace
          userId="user01"
          cloudUrl="http://localhost"
          status={{ ok: true, enabled: true, defaultModelId: "standard", visionModelConfigured: false, error: null, models }}
          models={models}
          lastModelId="standard"
          timeZone="UTC"
          renderedAt={now}
          initialLiveCursor="s6t.cloud-live-core.0"
          initialConversations={active ? [initial] : []}
          initialDoneCount={0}
          initialConversationId={active ? conversation.id : null}
          initialArtifactPath={null}
          initialDetail={active ? { conversation: initial, messages: [], hasMoreMessages: false, activeTurn: null, timeline: [] } : null}
          initialContext={null}
          projects={options.project ? [project] : []}
          initialProject={options.project ? project : null}
          initialProjectChats={options.project ? { items: [], page: 1, perPage: 20, total: 0, hasNext: false } : null}
          initialProjectContext={
            options.project
              ? {
                  projectId: project.id,
                  knowledge: [],
                  files: [],
                  references: [],
                  skills: { items: [], page: 1, hasNext: false },
                  apps: { items: [], page: 1, hasNext: false },
                }
              : null
          }
          approvals={{ page: { items: [], nextCursor: null, count: options.pendingApprovals ?? 0, elsewhere: 0 }, open: false }}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  cleanups.push(dispose);
  delegateEvents(["click", "input", "keydown"]);
  const input = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
  expect(input).not.toBeNull();
  batch(() => {
    input.value = options.content ? `${input.value} /` : "Plan /";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  input.click();
  const row = () =>
    [...dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (row) => row.querySelector("strong")?.textContent === "Neue Aufgabe",
    );
  await waitFor(() => Boolean(row()));
  const choose = () => row()!.click();
  return {
    ...dom,
    input,
    row,
    choose,
    saves,
    creates,
    dispose,
    status: () => dom.root.querySelector(".k2b-chat-composer__status")?.textContent,
  };
};

test("choosing an app Command saves the token-free draft with its revision, then opens with the chat return path", async () => {
  const h = await mount();
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 1);
  expect(events).toEqual(["save", "open"]);
  expect(h.saves).toEqual([{ expectedRevision: 4, content: [{ type: "text", text: "Plan" }] }]);
  expect(openCommand).toHaveBeenCalledWith(
    "spaces.task.compose",
    {},
    { returnTo: "/app/assistant?conversation=chat01" },
    expect.any(AbortSignal),
  );
});

test("a save conflict opens nothing and reports why in the composer status line", async () => {
  const h = await mount({ conflict: true });
  h.choose();
  await waitFor(() => Boolean(h.status()?.includes("Nichts wurde geöffnet")));
  expect(h.status()).toContain("Der Entwurf konnte nicht gespeichert werden.");
  expect(openCommand).not.toHaveBeenCalled();
  expect(h.input.value).toBe("Plan /");
  // The draft is now known to conflict: choosing again names the conflict without another request.
  const saves = h.saves.length;
  batch(() => {
    h.input.value = "Plan / /";
    h.input.setSelectionRange(h.input.value.length, h.input.value.length);
    h.input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  h.input.click();
  await waitFor(() => Boolean(h.row()));
  h.choose();
  await waitFor(() => Boolean(h.status()?.includes("woanders geändert")));
  expect(h.saves).toHaveLength(saves);
  expect(openCommand).not.toHaveBeenCalled();
});

test("an unreachable app leaves the row, slash list, and original value available for retry", async () => {
  openCommand.mockRejectedValueOnce(new Error("Offline"));
  const h = await mount();
  h.choose();
  await waitFor(() => Boolean(h.row()?.textContent?.includes("Spaces ist gerade nicht erreichbar.")));
  expect(h.input.value).toBe("Plan /");
  expect(h.root.querySelector('[role="listbox"]')).not.toBeNull();
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 2);
});

test("a project composer creates a chat without navigating, saves there, and returns to it", async () => {
  const h = await mount({ project: true });
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 1);
  expect(events).toEqual(["create", "save", "open"]);
  expect(h.creates).toEqual([{ title: "Neuer Chat", projectId: "Proj01" }]);
  expect(h.saves).toEqual([{ expectedRevision: 0, content: [{ type: "text", text: "Plan" }] }]);
  expect(openCommand).toHaveBeenCalledWith(
    "spaces.task.compose",
    {},
    { returnTo: "/app/assistant?conversation=new001" },
    expect.any(AbortSignal),
  );
  expect(h.window.location.search).toBe("?project=Proj01");
});

test("a plain new chat creates its target before saving and keeps the saved draft on screen", async () => {
  const h = await mount({ newChat: true });
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 1);
  expect(events).toEqual(["create", "save", "open"]);
  expect(h.root.querySelector("textarea")?.value).toBe("Plan ");
  expect(openCommand).toHaveBeenCalledWith(
    "spaces.task.compose",
    {},
    { returnTo: "/app/assistant?conversation=new001" },
    expect.any(AbortSignal),
  );
});

test("cancelling an app Command while a plain chat is being created preserves later edits", async () => {
  let release!: () => void;
  const createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await mount({ newChat: true, createGate });
  h.choose();
  await waitFor(() => h.creates.length === 1);
  expect(h.input.readOnly).toBe(true);
  h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !h.input.readOnly);
  expect(h.input.disabled).toBe(false);
  batch(() => {
    h.input.value = "New edits after cancel";
    h.input.setSelectionRange(h.input.value.length, h.input.value.length);
    h.input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  release();
  await waitFor(() => h.saves.length === 1);
  await Bun.sleep(50);
  expect(h.root.querySelector("textarea")?.value).toBe("New edits after cancel");
  expect(h.saves).toEqual([{ expectedRevision: 0, content: [{ type: "text", text: "New edits after cancel" }] }]);
  expect(openCommand).not.toHaveBeenCalled();
});

test("an unreachable app from a plain new chat names the failure in the status line of the chat it created", async () => {
  openCommand.mockRejectedValueOnce(new Error("Offline"));
  const h = await mount({ newChat: true });
  h.choose();
  // The draft moved to the new chat as it was saved, without "/…", so the list it was chosen in is gone; the status
  // line says what happened.
  await waitFor(() => Boolean(h.status()?.includes("Spaces ist gerade nicht erreichbar.")));
  expect(h.root.querySelector("textarea")?.value).toBe("Plan ");
});

test("retrying from a project reuses its pending chat", async () => {
  openCommand.mockRejectedValueOnce(new Error("Offline"));
  const h = await mount({ project: true });
  h.choose();
  await waitFor(() => Boolean(h.row()?.textContent?.includes("Spaces ist gerade nicht erreichbar.")));
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 2);
  expect(h.creates).toHaveLength(1);
  expect(events).toEqual(["create", "save", "save", "open"]);
});

test("saving an app-opening draft preserves inline references and attachments through the revisioned path", async () => {
  const reference = {
    type: "resource" as const,
    ref: { type: "notebooks.note", id: "note01" },
    title: "Q3 plan",
    icon: "ti ti-note",
    href: "/app/notebooks/note01",
    inline: true,
  };
  const file = { type: "file" as const, path: "/report.pdf", mediaType: "application/pdf", size: 12, version: 2 };
  const h = await mount({ content: [{ type: "text", text: "Read " }, reference, file] });
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 1);
  expect(h.saves).toEqual([
    { expectedRevision: 4, content: [{ type: "text", text: "Read " }, reference, { type: "text", text: " " }, { ...file, inline: false }] },
  ]);
});

test("moving to another chat while the draft saves opens nothing and says why", async () => {
  let release!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await mount({ saveGate });
  h.choose();
  await waitFor(() => events.includes("save"));
  const newChat = [...h.root.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Neuer Chat" || button.getAttribute("aria-label") === "Neuer Chat",
  );
  expect(newChat).toBeDefined();
  newChat!.click();
  await waitFor(() => h.window.location.search !== "?conversation=chat01");
  release();
  await waitFor(() => Boolean(h.status()?.includes("anderen Chat")));
  expect(openCommand).not.toHaveBeenCalled();
});

test("a composer that goes away while the draft saves, such as for Approvals, opens nothing", async () => {
  let release!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await mount({ saveGate });
  h.choose();
  await waitFor(() => events.includes("save"));
  h.dispose();
  release();
  await Bun.sleep(50);
  expect(openCommand).not.toHaveBeenCalled();
});

test("a queued app-opening save does not mark edits made after Escape as saved", async () => {
  let release!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await mount({ saveGate });
  await waitFor(() => h.saves.length === 1, 3_000);
  h.choose();
  expect(h.input.readOnly).toBe(true);
  h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !h.input.readOnly);
  batch(() => {
    h.input.value = "Newer plan";
    h.input.setSelectionRange(h.input.value.length, h.input.value.length);
    h.input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  release();
  // The queued save keeps its snapshot; the newer text follows it, and nothing marks it saved before that.
  await waitFor(() => h.saves.length >= 3, 3_000);
  expect(h.saves[1]).toEqual({ expectedRevision: 5, content: [{ type: "text", text: "Plan" }] });
  expect(h.saves[2]).toEqual({ expectedRevision: 6, content: [{ type: "text", text: "Newer plan" }] });
  expect(openCommand).not.toHaveBeenCalled();
}, 10_000);

test("opening Approvals while an app Command creates a plain chat keeps Approvals and its URL", async () => {
  let release!: () => void;
  const createGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await mount({ newChat: true, createGate, pendingApprovals: 1 });
  h.choose();
  await waitFor(() => h.creates.length === 1);
  const approvals = h.root.querySelector<HTMLAnchorElement>('a[href="/app/assistant?approvals=1"]');
  expect(approvals).not.toBeNull();
  approvals!.click();
  await waitFor(() => h.window.location.search === "?approvals=1");
  const heading = h.root.querySelector("h1");
  expect(heading).not.toBeNull();
  expect(h.root.querySelector("textarea")).toBeNull();
  const href = h.window.location.href;
  release();
  await waitFor(() => h.saves.length === 1);
  await Bun.sleep(50);
  expect(h.window.location.href).toBe(href);
  expect(h.root.querySelector("h1") === heading).toBe(true);
  expect(h.root.querySelector("textarea")).toBeNull();
  expect(openCommand).not.toHaveBeenCalled();
});

test("Escape while the app link resolves saves the live draft again, so a reload keeps its slash", async () => {
  openCommand.mockImplementation(
    (_id, _input, _options, signal) =>
      new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const h = await mount();
  h.choose();
  await waitFor(() => openCommand.mock.calls.length === 1);
  expect(h.saves).toEqual([{ expectedRevision: 4, content: [{ type: "text", text: "Plan" }] }]);
  h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => h.saves.length === 2);
  expect(h.saves[1]).toEqual({ expectedRevision: 5, content: [{ type: "text", text: "Plan /" }] });
  expect(h.input.value).toBe("Plan /");
});
