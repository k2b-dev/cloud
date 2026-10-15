import type { AiProject } from "@k2b/cloud/ai";
import { type AiComposerAttachment, aiChatAttachments } from "@k2b/cloud/ai/ui";
import type { ChatCommand, ChatCommandResult } from "@k2b/ui";
import { assistantApi } from "../api/client";
import { artifactClient } from "../artifacts/client";
import { type AssistantCopy, assistantCopyFor } from "./ui-copy";

export function assistantBuiltInCommands(input: {
  copy: AssistantCopy;
  projectComposer: boolean;
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
      id: "compact",
      name: "compact",
      icon: "ti ti-fold",
      label: t.compactLabel,
      keywords: ["compact", "kompaktieren", "kontext", "zusammenfassen", "platz"],
      description: t.compactDescription,
      busyLabel: t.compactBusy,
      reason: input.projectComposer
        ? t.commandNeedsChat
        : !input.hasMessages
          ? t.commandNeedsMessages
          : input.running
            ? t.commandNeedsIdle
            : undefined,
      action: input.compact,
    },
    {
      id: "fork",
      name: "fork",
      icon: "ti ti-git-fork",
      label: t.forkLabel,
      keywords: ["fork", "abzweigen", "kopie", "verzweigen", "branch"],
      description: t.forkDescription,
      busyLabel: t.forkBusy,
      reason: input.projectComposer
        ? t.commandNeedsChat
        : !input.hasAssistantMessage
          ? t.commandNeedsAnswer
          : input.running
            ? t.commandNeedsIdle
            : undefined,
      action: input.fork,
    },
    {
      id: "new",
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
  signal: AbortSignal;
  locale: string;
  conversationId?: string;
  projectId?: string | null;
  projects: readonly AiProject[];
  assignProject: (projectId: string) => Promise<void>;
  running: boolean;
}): Promise<ChatCommand[]> {
  const de = input.locale.startsWith("de");
  const copy = assistantCopyFor(input.locale);
  const match = /^(skill|app|file|project)(?:\s+(.*))?$/i.exec(input.query);
  const category = match?.[1]?.toLowerCase();
  const query = (match ? (match[2] ?? "") : input.query).trim().toLowerCase();
  const includes = (text: string) => text.toLowerCase().includes(query);
  const wants = (kind: string) => !category || category === kind;
  const reference = (name: string, description: string, attachment: AiComposerAttachment): ChatCommand => ({
    name,
    label: name,
    description,
    icon: attachment.kind === "image" ? "ti ti-photo" : attachment.icon,
    mention: aiChatAttachments([attachment])[0]!,
  });
  const [skills, apps, chatFiles, project] = await Promise.all([
    wants("skill") ? assistantApi.listSkills(input.signal, query.slice(0, 200)) : [],
    wants("app") ? artifactClient.list(1, query.slice(0, 120), input.signal, input.conversationId) : null,
    wants("file") && input.conversationId ? assistantApi.listChatFiles(input.conversationId, input.signal) : [],
    wants("file") && input.projectId ? assistantApi.loadProjectContext(input.projectId, input.signal) : null,
  ]);
  const results: ChatCommand[] = [];
  for (const skill of skills) {
    if (!skill.enabled) continue;
    results.push(
      reference(skill.name, `Skill · ${skill.description}`, {
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
      reference(app.title, `App · ${app.description ?? ""}`, {
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
      reference(file.path.split("/").at(-1) || file.path, `${de ? "Chat-Datei" : "Chat file"} · ${file.path}`, {
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
      reference(path, de ? "Projektdatei" : "Project file", { kind: "project-file", id: path, path, name: path, icon: "ti ti-file" }),
    );
  }
  if (wants("project") && !input.projectId)
    for (const project of input.projects) {
      if (!includes(`${project.name} ${project.description}`)) continue;
      results.push({
        name: project.name,
        label: project.name,
        icon: project.icon || "ti ti-folders",
        reason: input.running ? copy.commandNeedsIdle : undefined,
        description: copy.assignProjectDescription,
        action: () => input.assignProject(project.id),
      });
    }
  // Search results and the menu stay bounded.
  return results.slice(0, 30);
}
