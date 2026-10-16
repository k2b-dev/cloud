import type { AiProject } from "@k2b/cloud/ai";
import { type AiComposerAttachment, aiChatAttachments } from "@k2b/cloud/ai/ui";
import type { ChatCommand, ChatCommandResult, ChatCommandScope, ChatCommandSection } from "@k2b/ui";
import { assistantApi } from "../api/client";
import { artifactClient } from "../artifacts/client";
import { type AssistantCopy, assistantCopyFor } from "./ui-copy";

export const assistantCommandSections = (copy: AssistantCopy): ChatCommandSection[] => [
  { id: "skills", label: copy.commandSkills, searched: true },
  { id: "files", label: copy.commandFiles, searched: true, searchOnly: true },
  { id: "apps", label: copy.commandApps, searched: true },
  { id: "chat", label: copy.commandChat },
];

export const assistantCommandScopes = (copy: AssistantCopy, locale: string): ChatCommandScope[] => [
  { id: "skill", title: copy.commandSkills, words: ["skill", "skills"] },
  {
    id: "file",
    title: copy.commandFiles,
    words: locale.startsWith("de") ? ["datei", "dateien", "file", "files"] : ["file", "files", "datei", "dateien"],
  },
  {
    id: "project",
    title: copy.commandProjects,
    words: locale.startsWith("de") ? ["projekt", "projekte", "project", "projects"] : ["project", "projects", "projekt", "projekte"],
  },
  { id: "app", title: copy.commandApps, words: ["app", "apps", "studio"] },
];

export function assistantBuiltInCommands(input: {
  copy: AssistantCopy;
  projectComposer: boolean;
  projectName?: string | null;
  running: boolean;
  hasMessages: boolean;
  hasAssistantMessage: boolean;
  compact: () => Promise<ChatCommandResult>;
  fork: () => Promise<ChatCommandResult>;
  newChat: () => Promise<ChatCommandResult>;
}): ChatCommand[] {
  const t = input.copy;
  return [
    {
      id: "project",
      name: "project",
      label: t.assignProjectLabel,
      description: t.assignProjectHint,
      icon: "ti ti-folders",
      keywords: ["project", "projekt", "zuordnen", "assign"],
      scope: "project",
      section: "chat",
      hiddenUntilSearch: input.projectName != null,
      reason:
        input.projectName != null ? t.commandAlreadyProject({ name: input.projectName }) : input.running ? t.commandNeedsIdle : undefined,
    },
    {
      id: "compact",
      section: "chat",
      hiddenUntilSearch: !input.running && (input.projectComposer || !input.hasMessages),
      name: "compact",
      icon: "ti ti-fold",
      label: t.compactLabel,
      keywords: ["compact", "kompaktieren", "kontext", "zusammenfassen", "platz"],
      description: t.compactDescription,
      busyLabel: t.compactBusy,
      reason: input.running
        ? t.commandNeedsIdle
        : input.projectComposer
          ? t.commandNeedsChat
          : !input.hasMessages
            ? t.commandNeedsMessages
            : undefined,
      action: input.compact,
    },
    {
      id: "fork",
      section: "chat",
      hiddenUntilSearch: !input.running && (input.projectComposer || !input.hasAssistantMessage),
      name: "fork",
      icon: "ti ti-git-fork",
      label: t.forkLabel,
      keywords: ["fork", "abzweigen", "kopie", "verzweigen", "branch"],
      description: t.forkDescription,
      busyLabel: t.forkBusy,
      reason: input.running
        ? t.commandNeedsIdle
        : input.projectComposer
          ? t.commandNeedsChat
          : !input.hasAssistantMessage
            ? t.commandNeedsAnswer
            : undefined,
      action: input.fork,
    },
    {
      id: "new",
      section: "chat",
      name: "new",
      icon: "ti ti-plus",
      label: t.newChatLabel,
      keywords: ["new", "neu", "chat", "leer"],
      description: t.newChatDescription,
      action: input.newChat,
    },
  ];
}

/** Only explicit selection inserts a reference or performs an action. */
export async function assistantComposerCommands(input: {
  query: string;
  scope?: string;
  signal: AbortSignal;
  locale: string;
  conversationId?: string;
  projectId?: string | null;
  projects: readonly AiProject[];
  assignProject: (projectId: string) => Promise<void>;
  running: boolean;
}): Promise<ChatCommand[]> {
  const copy = assistantCopyFor(input.locale);
  const legacyScope = !input.scope
    ? assistantCommandScopes(copy, input.locale).find(
        (scope) => scope.id !== "project" && scope.words.includes(input.query.trim().toLowerCase()),
      )
    : undefined;
  const category = input.scope ?? legacyScope?.id;
  const query = (legacyScope ? "" : input.query).trim().toLowerCase();
  const includes = (text: string) => text.toLowerCase().includes(query);
  const wants = (kind: string) => !category || category === kind;
  // The attachment id is the row key: two files named "report.md" in different folders stay two rows.
  const reference = (section: string, name: string, description: string, attachment: AiComposerAttachment): ChatCommand => ({
    section,
    id: attachment.id,
    name,
    label: name,
    description,
    icon: attachment.kind === "image" ? "ti ti-photo" : attachment.icon,
    mention: aiChatAttachments([attachment])[0]!,
  });
  const [skills, apps, chatFiles, project] = await Promise.all([
    wants("skill") ? assistantApi.listSkills(input.signal, query.slice(0, 200)) : [],
    wants("app") ? artifactClient.list(1, query.slice(0, 120), input.signal, input.conversationId) : null,
    (category === "file" || (!category && query.length > 0)) && input.conversationId
      ? assistantApi.listChatFiles(input.conversationId, input.signal)
      : [],
    (category === "file" || (!category && query.length > 0)) && input.projectId
      ? assistantApi.loadProjectContext(input.projectId, input.signal)
      : null,
  ]);
  const results: ChatCommand[] = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    results.push(
      reference("skills", skill.name, `Skill · ${skill.description}`, {
        kind: "resource",
        id: `skill:${skill.id}`,
        name: skill.name,
        ref: { type: "core.ai.skill", id: skill.shortId },
        icon: "ti ti-sparkles",
      }),
    );
  }
  for (const app of apps?.items ?? []) {
    if (app.kind !== "app") continue;
    results.push(
      reference("apps", app.title, `App · ${app.description ?? ""}`, {
        kind: "resource",
        id: `app:${app.id}`,
        name: app.title,
        ref: { type: "assistant.artifact", id: app.id },
        icon: app.icon || "ti ti-app-window",
        href: `/app/assistant/apps/${app.id}`,
      }),
    );
  }
  for (const file of chatFiles) {
    if (!includes(file.path)) continue;
    results.push(
      reference("files", file.path.split("/").at(-1) || file.path, `${copy.chatFileDescription} · ${file.path}`, {
        kind: "stored-file",
        id: `file:${file.path}:${file.version}`,
        name: file.path.split("/").at(-1) || file.path,
        path: file.path,
        version: file.version,
        size: file.size,
        mediaType: file.mediaType,
        icon: "ti ti-file",
      }),
    );
  }
  for (const file of project?.files ?? []) {
    if (!includes(file.path)) continue;
    const path = `/project/${file.path.replace(/^\/+/, "")}`;
    results.push(
      reference("files", path, copy.projectFileDescription, { kind: "project-file", id: path, path, name: path, icon: "ti ti-file" }),
    );
  }
  const assignedProject = input.projectId ? input.projects.find((project) => project.id === input.projectId) : undefined;
  if (category === "project")
    for (const project of input.projects) {
      if (!includes(`${project.name} ${project.description}`)) continue;
      results.push({
        id: `project:${project.id}`,
        name: project.name,
        label: project.name,
        icon: project.icon || "ti ti-folders",
        reason: input.projectId
          ? copy.commandChatAlreadyProject({
              name: assignedProject?.name,
            })
          : input.running
            ? copy.commandNeedsIdle
            : undefined,
        description: copy.assignProjectDescription,
        action: () => input.assignProject(project.id),
      });
    }
  // Search results and the menu stay bounded.
  return results.slice(0, 30);
}
