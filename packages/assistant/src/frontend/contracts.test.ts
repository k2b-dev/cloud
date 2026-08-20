import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Assistant frontend contracts", () => {
  test("uses the typed JSON client and user-backed route guards", async () => {
    const [client, apiRoutes, pageRoutes] = await Promise.all([read("../api/client.ts"), read("../api/index.ts"), read("./index.ts")]);

    expect(client).toContain("api.create<ApiType>");
    expect(client.match(/fetch\(/g)).toHaveLength(1);
    expect(client).toContain("/api/ai/tasks");
    expect(apiRoutes).toContain("auth.requireUser()");
    expect(pageRoutes).toContain("auth.requireUser(auth.redirectToLogin)");
  });

  test("keeps one hydration boundary and viewport-safe dialogs", async () => {
    const [allChats, allChatsList, conversationEditor, preferences, artifacts] = await Promise.all([
      read("./AssistantAllChatsDialog.tsx"),
      read("./AssistantAllChatsList.tsx"),
      read("./AssistantConversationEditor.tsx"),
      read("./AssistantPrefsModals.tsx"),
      read("./AssistantArtifactDetail.tsx"),
    ]);

    expect(allChats).not.toContain(".island");
    expect(allChats).toContain("panelDialogFixedOptions");
    expect(allChatsList).toContain("<Link");
    expect(allChatsList).toContain("assistantConversationHref");
    expect(conversationEditor).toContain('title="Chat Settings"');
    expect(conversationEditor).not.toContain('title="General"');
    for (const source of [conversationEditor, preferences, artifacts]) {
      expect(source).not.toContain("h-[86vh]");
      expect(source).toContain("dialog-fixed-frame");
    }
  });

  test("keeps Projects and chat context inside the Assistant workspace", async () => {
    const [workspace, sidebar, projectsDialog, project, context, tasks, projectSettings] = await Promise.all([
      read("./AssistantWorkspace.island.tsx"),
      read("./AssistantSidebar.tsx"),
      read("./AssistantProjectsDialog.tsx"),
      read("./AssistantProjectView.tsx"),
      read("./AssistantChatContext.tsx"),
      read("./AssistantTasksDialog.tsx"),
      read("./AssistantProjectSettingsDialog.tsx"),
    ]);

    expect(sidebar).toContain("AppWorkspace.NavTree");
    expect(sidebar).toContain('title="Projects"');
    expect(sidebar).toContain('label="Create Project"');
    expect(sidebar).not.toContain("onOpenProjects");
    expect(sidebar).toContain("No recent chats");
    expect(projectsDialog).toContain("prompts.form");
    expect(projectsDialog).not.toContain("divide-y");
    expect(projectsDialog).not.toContain("rounded-lg border");
    expect(projectsDialog).not.toContain("listProjects");
    expect(project).toContain("openSpotlightSearch");
    expect(project).toContain("Search chats in ${props.project.name}");
    expect(project).not.toContain("TextInput");
    expect(project).toContain("IntersectionObserver");
    expect(project).toContain("<AssistantContextSection");
    expect(project).not.toContain("<Paper");
    expect(project).not.toContain("StatusBadge");
    expect(project).not.toContain("admin access");
    expect(project).toContain('props.project.permission !== "read"');
    expect(workspace).toContain("sendProjectMessage");
    expect(workspace).toContain("<AssistantComposer projectId=");
    expect(workspace).toContain("navigateTo(assistantConversationHref");
    expect(workspace).toContain("AssistantChatContextPanel");
    expect(workspace).toContain('class="flex min-h-0 flex-1"');
    expect(workspace).toContain('class="flex min-w-0 flex-1 flex-col"');
    expect(workspace).toContain('class="flex justify-end lg:hidden"');
    expect(workspace).not.toContain("<AppWorkspace.Detail");
    expect(context).toContain("AssistantChatContextContent");
    expect(context).toContain("openAssistantContextFiles");
    expect(context).toContain("loadAssistantContextImages");
    expect(context).toContain("openAssistantKnowledgeSearch");
    expect(context).not.toContain("AssistantChatDetailPanel");
    expect(context).not.toContain("IconButton");
    expect(tasks).toContain("DateTimePicker");
    expect(tasks).toContain("<Select");
    expect(tasks).not.toContain("<select");
    expect(tasks).not.toContain('type="datetime-local"');
    expect(projectSettings).toContain("<SettingsModal");
  });

  test("keeps Assistant composer actions in one contextual Plus menu", async () => {
    const [workspace, page, messageSearch] = await Promise.all([
      read("./AssistantWorkspace.island.tsx"),
      read("./page.tsx"),
      read("./AssistantChatMessageSearch.ts"),
    ]);

    expect(workspace).not.toContain("type ChatCommand");
    expect(workspace).not.toContain("const slashCommands");
    expect(workspace).not.toContain("commands={");
    expect(workspace).not.toContain("type / ...");
    expect(workspace).toContain('id: "attach-resource"');
    expect(workspace).toContain('id: "paste-resource"');
    expect(workspace).toContain("openCloudResourcePicker");
    expect(workspace).toContain("cloudResourceClipboard.parse(structured, props.cloudUrl)");
    expect(workspace).toContain("createAiPastedTextFile(text)");
    expect(workspace).toContain("onShowText:");
    expect(page).toContain('coreSettings.get<string>("app.url")');
    expect(page).toContain("cloudUrl={publicCloudOrigin(appUrl)}");
    expect(workspace).toContain("composerAttachmentsFor(sessionKey).length >= AI_TURN_ATTACHMENT_MAX_ITEMS");
    expect(workspace).toContain('id: "search-chat"');
    expect(workspace).toContain('id: "compact-context"');
    expect(workspace).toContain("openAssistantChatMessageSearch");
    expect(workspace).toContain("loadHistoryThroughSeq");
    expect(messageSearch).toContain("openSpotlightSearch");
    expect(messageSearch).not.toContain("listConversationResources");
    expect(messageSearch).not.toContain("listResources");
  });

  test("queues follow-up messages locally and presents one minimal connection notice", async () => {
    const workspace = await read("./AssistantWorkspace.island.tsx");

    expect(workspace).toContain('runningSubmitIntent={!projectComposer() ? "queue" : undefined}');
    expect(workspace).toContain('input.intent === "queue"');
    expect(workspace).toContain("<AssistantQueuedMessages");
    expect(workspace).toContain('chat.runStatus() !== "idle"');
    expect(workspace).toContain('message: "Reconnecting…"');
    expect(workspace).toContain('"animation-direction": "reverse"');
    expect(workspace).not.toContain("bg-red-50");
    expect(workspace).not.toContain("bg-amber-50");
  });

  test("frames structured memories as personalization", async () => {
    const [preferences, client] = await Promise.all([read("./AssistantPrefsModals.tsx"), read("../api/client.ts")]);

    expect(preferences).toContain('title="Personalization"');
    expect(preferences).toContain("Facts and preferences Assistant may carry into future conversations.");
    expect(preferences).toContain("Search personalization");
    expect(preferences).toContain("Add personalization");
    expect(preferences).toContain('variant="input"');
    expect(preferences).not.toContain("suffix={");
    expect(preferences).toContain("Use personalization in Assistant chats");
    expect(preferences).toContain("Learn personalization from private chats");
    expect(preferences).toContain('title="Saved personalization"');
    expect(preferences).toContain("hasSavedPersonalization");
    expect(preferences).toContain('state="empty"');
    expect(preferences).toContain('title="No personalization yet"');
    expect(preferences).toContain("SettingsPanelFooter");
    expect(preferences).toContain("confirmDiscardIfDirty");
    expect(preferences).toContain("SettingsCollection.Item.Actions");
    expect(preferences).not.toContain("Find personalization");
    expect(preferences).toContain("System prompt");
    expect(preferences).not.toContain("Custom instructions");
    expect(preferences).not.toContain("PanelDialog");
    expect(preferences).toContain('{ title: "Add personalization", icon: "ti ti-user-cog", size: "large" }');
    expect(preferences).toMatch(/title: "Edit personalization",\s+size: "large",\s+confirmText: "Save"/);
    expect(preferences).toMatch(/default: memory\.content,\s+multiline: true,\s+lines: 8/);
    expect(preferences).toContain('<Button variant="ghost" loading={busyId() === "new"}');
    expect(preferences).toContain("lines={8}");
    expect(preferences).toContain('class="grid gap-1"');
    expect(preferences).toContain('memory.kind === "preference" ? "ti ti-adjustments" : "ti ti-info-circle"');
    expect(preferences).toContain("<Dropdown.Root");
    expect(preferences).toContain('label: memory.priority === "pinned" ? "Unpin" : "Pin"');
    expect(preferences).toContain('{ label: "Delete", icon: "ti ti-trash", variant: "danger"');
    expect(preferences).toContain("Pin");
    expect(preferences).not.toContain("Forget personalization");
    expect(client).toContain("createMemory");
    expect(client).toContain("updateMemory");
    expect(client).toContain("deleteMemory");
    expect(client).not.toContain("memory?: string");
  });

  test("keeps shared Skills in Personalization with one replaceable editor frame", async () => {
    const [preferences, skills, files, client] = await Promise.all([
      read("./AssistantPrefsModals.tsx"),
      read("./AssistantSkillsSettings.tsx"),
      read("./assistant-skill-files.ts"),
      read("../api/client.ts"),
    ]);

    expect(preferences).toContain('id="skills"');
    expect(preferences).not.toContain("<SettingsModal.Group");
    expect(preferences).toContain("skillEditor()");
    expect(preferences).toContain("<AssistantSkillEditor");
    expect(skills).toContain("<NoticeCard");
    expect(skills).toContain("Skills teach Assistant how to handle specific tasks");
    expect(skills).toContain('label="Enabled for me"');
    expect(skills).toContain("setSkillEnabled");
    expect(skills).toContain("<MarkdownEditor");
    expect(skills).toContain("AssistantSkillReferenceEditor");
    expect(skills).toContain("AssistantSkillReferencesEditor");
    expect(skills).toContain("Description controls when this Skill loads");
    expect(skills).toContain("Start with an action and say when to use it");
    expect(skills).toContain("Create weekly status reports from recent work");
    expect(skills).toContain('class="flex flex-col gap-4"');
    expect(skills).toContain('class="min-h-[18rem] flex-1"');
    expect(skills).toContain("                fill\n");
    expect(skills).not.toContain('<PanelDialog surface="floating">');
    expect(preferences).toContain("rounded-[var(--ui-radius-frame)]");
    expect(skills).toContain('title="No extra info yet"');
    expect(skills).toContain('variant="panel"');
    expect(skills).toContain('variant="input"');
    expect(skills).toContain("Extra info");
    expect(skills).not.toContain("Back to skills");
    expect(skills).toContain("Remove reference");
    expect(skills).not.toContain("Skill file");
    expect(skills).not.toContain("Reference filename");
    expect(skills).not.toContain("This becomes /skills/");
    expect(skills).toContain("<PermissionEditor");
    expect(files).toContain('file.name.toLowerCase() === "skill.md"');
    expect(files).toContain("parseAiSkillArchive");
    expect(client).toContain("listSkillAccess");
    expect(client).toContain("setSkillEnabled");
  });
});
