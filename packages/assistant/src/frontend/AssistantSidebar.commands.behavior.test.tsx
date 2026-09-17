import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (!isServer) {
  test("all-chat search releases its shortcut while a chat is open and restores it on leaving", async () => {
    const dom = createDomTestHarness();
    const { default: AssistantSidebar } = await import("./AssistantSidebar");
    const { createAssistantLiveInvalidationHub } = await import("./assistant-live");
    const { contextCommandsWithShortcuts } = await import("@k2b/cloud/browser/testing");
    const [project, setProject] = createSignal<string | null>(null);
    const projectRecord = { id: "Proj01", shortId: "Proj01", name: "Work", description: "", icon: "ti ti-folders", instructions: "", defaultModelProfileId: null, permission: "read" as const, revision: 1, createdAt: "", updatedAt: "" };
    const [chat, setChat] = createSignal<string | null>(null);
    const live = createAssistantLiveInvalidationHub({ onApplied: () => undefined });
    const dispose = render(() => <AssistantSidebar conversations={() => []} activeConversationId={chat} activeProjectId={project()} projects={[projectRecord]} live={live} />, dom.root);
    const search = () => contextCommandsWithShortcuts().find((command) => command.id === "assistant.search");
    try {
      expect(search()?.shortcut).toBe("mod+shift+k");
      setChat("Chat01");
      expect(search()?.shortcut).toBeUndefined();
      expect(search()?.action).toMatchObject({ search: { scope: { appId: "assistant" } } });
      setChat(null);
      expect(search()?.shortcut).toBe("mod+shift+k");
      setProject("Proj01");
      expect(search()).toMatchObject({ shortcut: "mod+shift+k", title: "Search chats in this project", action: { search: { scope: { ref: { type: "assistant.project", id: "Proj01" }, label: "Work" } } } });
      setProject(null);
      expect(search()?.action).toMatchObject({ search: { scope: { appId: "assistant" } } });
      dispose();
      expect(search()).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
