import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AiFileStat, AiProject, AiProjectFile } from "@k2b/cloud/ai";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AssistantChatContextSnapshot } from "../chat-context";
import type { AssistantProjectContextSnapshot } from "../project-context";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const chatFile = (path: string, origin: AiFileStat["origin"]): AiFileStat => ({
  path,
  size: 2048,
  mediaType: "application/pdf",
  origin,
  updatedAt: "2026-09-27T10:00:00.000Z",
  version: 1,
});
const chatSnapshot = (files: AiFileStat[]): AssistantChatContextSnapshot => ({
  chatId: "Chat01",
  sources: [],
  files,
  tasks: [],
  viewerUserId: "user-1",
  apps: [],
  runCount: 0,
  runs: [],
});
const project: AiProject = {
  id: "Proj01",
  shortId: "Proj01",
  name: "Launch",
  description: "",
  icon: "ti ti-folder",
  instructions: "",
  defaultModelProfileId: null,
  permission: "admin",
  revision: 1,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};
const projectFile: AiProjectFile = {
  id: "File01",
  shortId: "File01",
  projectId: "Proj01",
  path: "/brief.pdf",
  mediaType: "application/pdf",
  size: 1024,
  updatedAt: "2026-09-01T10:00:00.000Z",
};
const projectSnapshot: AssistantProjectContextSnapshot = {
  projectId: "Proj01",
  knowledge: [],
  files: [projectFile],
  references: [],
  skills: { items: [], page: 1, hasNext: false },
  apps: { items: [], page: 1, hasNext: false },
};

describe("Assistant chat files", () => {
  if (isServer) {
    test.skip("requires browser conditions and the DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());

  const mount = async (options: { confirm: boolean; deleteResponse?: () => Response }) => {
    const dom = createDomTestHarness();
    const { prompts, toast } = await import("@k2b/ui");
    const { AssistantChatContextContent } = await import("./AssistantChatContext");
    const { AssistantLiveProvider, createAssistantLiveInvalidationHub } = await import("./assistant-live");
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined, delayMs: 1 });
    let files = [chatFile("/report.pdf", "assistant"), chatFile("/upload.pdf", "user")];
    const requests: { method: string; url: string }[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, url });
          if (method === "DELETE") {
            const response = options.deleteResponse?.() ?? Response.json({ deleted: true });
            if (response.ok) files = files.filter((file) => file.path !== new URL(url, "http://cloud.test").searchParams.get("path"));
            return response;
          }
          if (url.includes("/workspace/projects/Proj01/context")) return Response.json(projectSnapshot);
          if (url.includes("/workspace/conversations/Chat01/context")) return Response.json(chatSnapshot(files));
          return new Response(null, { status: 404 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(options.confirm);
    const toastError = spyOn(toast, "error").mockReturnValue({ dismiss() {}, update() {} });
    const deleted: { conversationId: string; path: string }[] = [];
    const dispose = render(
      () => (
        <AssistantLiveProvider value={live}>
          <AssistantChatContextContent
            chatId="Chat01"
            project={project}
            category="files"
            initial={chatSnapshot(files)}
            onOpenView={() => undefined}
            onFileDeleted={(file) => deleted.push(file)}
          />
        </AssistantLiveProvider>
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      fetchMock.mockRestore();
      confirm.mockRestore();
      toastError.mockRestore();
      live.dispose();
      dom.cleanup();
    };
    await tick();
    const row = (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>(".k2b-detail-panel__action-row, .k2b-detail-panel__action")).find((element) =>
        element.textContent?.includes(name),
      );
    const deleteButton = (name: string) => row(name)?.querySelector<HTMLButtonElement>('button[aria-label="Delete file"]') ?? null;
    const deletes = () => requests.filter((request) => request.method === "DELETE");
    return { confirm, toastError, deleted, row, deleteButton, deletes };
  };

  test("a confirmed trash action deletes the chat file, closes its tab and removes the row", async () => {
    const view = await mount({ confirm: true });
    // Both assistant output and uploads are chat files; the shared Project file stays read-only here.
    expect(view.deleteButton("report.pdf")).not.toBeNull();
    expect(view.deleteButton("upload.pdf")).not.toBeNull();
    expect(view.row("brief.pdf")).toBeDefined();
    expect(view.deleteButton("brief.pdf")).toBeNull();

    // The button sits in the row that reveals it on hover or keyboard focus.
    const button = view.deleteButton("report.pdf")!;
    expect(button.closest(".k2b-detail-panel__action-row")).toBe(view.row("report.pdf") ?? null);
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    await tick();
    await tick();

    expect(view.confirm).toHaveBeenCalledTimes(1);
    expect(view.confirm.mock.calls[0]?.[0]).toContain("“report.pdf”");
    expect(view.confirm.mock.calls[0]?.[1]).toMatchObject({ title: "Delete file", confirmText: "Delete", variant: "danger" });
    expect(view.deletes()).toEqual([{ method: "DELETE", url: "/api/ai/conversations/Chat01/files?path=%2Freport.pdf" }]);
    expect(view.deleted).toEqual([{ conversationId: "Chat01", path: "/report.pdf" }]);
    expect(view.row("report.pdf")).toBeUndefined();
    expect(view.row("upload.pdf")).toBeDefined();
    expect(view.toastError).not.toHaveBeenCalled();
  });

  test("cancelling the confirmation keeps the file", async () => {
    const view = await mount({ confirm: false });
    view.deleteButton("upload.pdf")!.click();
    await tick();
    await tick();

    expect(view.confirm).toHaveBeenCalledTimes(1);
    expect(view.deletes()).toEqual([]);
    expect(view.deleted).toEqual([]);
    expect(view.row("upload.pdf")).toBeDefined();
  });

  test("deleting from the workspace Files tab closes the open tab of that file", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const { ArtifactWorkspace, createArtifactWorkspace } = await import("../artifacts/Workspace");
    const { contextTab, fileTab } = await import("../artifacts/workspace-state");
    const { AssistantLiveProvider, createAssistantLiveInvalidationHub } = await import("./assistant-live");
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined, delayMs: 1 });
    let files = [chatFile("/report.pdf", "assistant"), chatFile("/upload.pdf", "user")];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = String(input);
          if (init?.method === "DELETE") {
            files = files.filter((file) => file.path !== new URL(url, "http://cloud.test").searchParams.get("path"));
            return Response.json({ deleted: true });
          }
          if (url.includes("/workspace/conversations/Chat01/context")) return Response.json(chatSnapshot(files));
          return Response.json({ message: "File not found" }, { status: 404 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const controller = createArtifactWorkspace();
    const dispose = render(
      () => (
        <AssistantLiveProvider value={live}>
          <ArtifactWorkspace controller={controller} userId="user-1" refreshKey="initial" onEditTask={() => undefined} />
        </AssistantLiveProvider>
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      fetchMock.mockRestore();
      confirm.mockRestore();
      live.dispose();
      dom.cleanup();
    };
    const reportTab = fileTab("Chat01", "/report.pdf");
    const uploadTab = fileTab("Chat01", "/upload.pdf");
    controller.open(reportTab);
    controller.open(uploadTab);
    controller.open(contextTab("Chat01", "files", "Files"));
    await tick();
    await tick();

    dom.root.querySelector<HTMLButtonElement>('[role="tabpanel"]:not([hidden]) button[aria-label="Delete file"]')!.click();
    await tick();
    await tick();

    expect(confirm.mock.calls[0]?.[0]).toContain("“report.pdf”");
    expect(controller.state().tabs.map((tab) => tab.key)).toEqual([uploadTab.key, contextTab("Chat01", "files", "Files").key]);
  });

  test("a failed deletion reports the server message in a toast and keeps the tab open", async () => {
    const view = await mount({ confirm: true, deleteResponse: () => Response.json({ message: "File not found" }, { status: 404 }) });
    view.deleteButton("report.pdf")!.click();
    await tick();
    await tick();

    expect(view.deletes()).toHaveLength(1);
    expect(view.toastError).toHaveBeenCalledWith("File not found", { title: "Could not delete file" });
    expect(view.deleted).toEqual([]);
    expect(view.row("report.pdf")).toBeDefined();
  });
});
