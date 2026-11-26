import type { AiProject } from "@k2b/cloud/ai";
import { formatFileViewSize, useLocale } from "@k2b/ui";
import { List, Row, Section } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { AssistantChatContextSnapshot } from "../../chat-context";
import type { ChatSidebarActions, ChatSidebarState } from "../AssistantChatSidebar";
import { openAssistantKnowledgeSearch, openAssistantMarkdown } from "../AssistantContextContent";
import { chatSidebarMessages } from "../chat-sidebar-messages";
import { type FileKind, fileKind } from "../chat-sidebar-model";
import { iconName } from "./assistant-nav";

const kindIcon: Record<FileKind, string> = {
  html: "file-type-html",
  image: "photo",
  table: "table",
  pdf: "file-type-pdf",
  script: "file-code",
  text: "file-text",
  other: "file",
};
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * "Kontext" of a chat on v2, the tab "In diesem Chat" opens: the chat's Project with its instructions, knowledge, files
 * and references, the Skills it used, what it remembered, and its secrets. Sections of rows, each row opening what it
 * names; the same data and deeds as v1's details (`ChatContextDetails`).
 */
export default function ChatContextDetailsV2(props: {
  snapshot: AssistantChatContextSnapshot;
  project: AiProject | null;
  state: ChatSidebarState;
  actions: ChatSidebarActions;
}) {
  const locale = useLocale();
  const copy = () => chatSidebarMessages.resolve([locale()]).t;
  const projectContext = () => {
    const context = props.state.projectContext();
    return context && props.project && context.projectId === props.project.id ? context : null;
  };
  return (
    <>
      <Show when={props.project}>
        {(project) => (
          <Section icon={iconName(project().icon, "folder")} color="var(--k2-app)" title={project().name}>
            <List label={project().name}>
              <Row
                icon="adjustments-horizontal"
                lines={[copy().projectInstructions]}
                onOpen={() =>
                  void openAssistantMarkdown(
                    copy().projectInstructions,
                    project().instructions || copy().noProjectInstructions,
                    "ti ti-adjustments-horizontal",
                  )
                }
              />
              <Show when={projectContext()?.knowledge.length}>
                {(count) => (
                  <Row
                    icon="bulb"
                    lines={[copy().projectKnowledge]}
                    meta={String(count())}
                    onOpen={() =>
                      props.actions.onOpenKnowledge
                        ? props.actions.onOpenKnowledge()
                        : void openAssistantKnowledgeSearch(projectContext()?.knowledge ?? [])
                    }
                  />
                )}
              </Show>
              <For each={props.actions.onOpenProjectFile ? (projectContext()?.files ?? []) : []}>
                {(file) => (
                  <Row
                    icon={kindIcon[fileKind(file.mediaType, file.path)]}
                    lines={[fileName(file.path)]}
                    meta={formatFileViewSize(file.size)}
                    onOpen={() => props.actions.onOpenProjectFile?.(file)}
                  />
                )}
              </For>
              <Show when={props.actions.onOpenReferences ? projectContext()?.references.length : undefined}>
                {(count) => (
                  <Row
                    icon="link"
                    lines={[copy().projectReferences]}
                    meta={String(count())}
                    onOpen={() => props.actions.onOpenReferences?.()}
                  />
                )}
              </Show>
            </List>
          </Section>
        )}
      </Show>
      <Show when={props.snapshot.skills.length > 0}>
        <Section icon="puzzle" title={copy().skillsUsed} count={props.snapshot.skills.length}>
          <List label={copy().skillsUsed}>
            <For each={props.snapshot.skills}>
              {(skill) => (
                <Row
                  icon="puzzle"
                  lines={skill.description ? [skill.name, skill.description] : [skill.name]}
                  meta={copy().skillTurns({ count: skill.turns })}
                />
              )}
            </For>
          </List>
        </Section>
      </Show>
      <Show when={props.snapshot.memories.length > 0}>
        <Section icon="bulb" title={copy().memoriesFromChat} count={props.snapshot.memories.length}>
          <List label={copy().memoriesFromChat}>
            <For each={props.snapshot.memories}>{(memory) => <Row icon="bulb" lines={[memory.content]} />}</For>
          </List>
        </Section>
      </Show>
      <Show when={props.actions.onOpenSecrets}>
        <List label={copy().secrets}>
          <Row icon="key" lines={[copy().secrets]} onOpen={() => props.actions.onOpenSecrets?.()} />
        </List>
      </Show>
    </>
  );
}
