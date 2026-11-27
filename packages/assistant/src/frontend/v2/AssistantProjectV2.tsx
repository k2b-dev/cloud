import type { AiConversation } from "@k2b/cloud/ai";
import { FileDropTarget, Format } from "@k2b/ui";
import { Band, Bar, Button as ButtonV2, Canvas, Cells, Empty, Failed, List, Pane, RecordHead, Row, Section, Text } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { ProjectParts } from "../AssistantProjectView";
import { assistantConversationHref } from "../assistant-navigation";

/**
 * A Project on v2 (screen brief 2, recipe "record-groups"): the Project's head with its name and deeds, one strip of
 * what it holds, its chats as rows of one shape with the composer after them, and its context as the side column. The
 * state and the deeds are the Project view's (`ProjectParts`); only v2's page loads this file, so the panel's island
 * keeps v1's parts alone.
 */
export default function AssistantProjectV2(p: ProjectParts) {
  return (
    <>
      <Pane.Split>
        <Pane
          label={p.props.project.name}
          head={
            <Bar
              start={<RecordHead name={p.props.project.name} kinds={[p.text("Project")]} />}
              end={
                <Show when={p.props.project.permission === "admin"}>
                  <ButtonV2 icon="settings" onClick={p.settings}>
                    {p.text("Project settings")}
                  </ButtonV2>
                </Show>
              }
            />
          }
        >
          <Show when={p.props.project.description}>
            <Band>
              <Text muted>{p.props.project.description}</Text>
            </Band>
          </Show>
          <Cells>
            <Cells.Cell icon="messages" label={p.text("Chats")} value={p.chatTotal()} />
            <Cells.Cell
              icon="bulb"
              label={p.text("Project knowledge")}
              value={p.context.data()?.knowledge.length ?? 0}
              loading={!p.context.data()}
            />
            <Cells.Cell icon="files" label={p.text("Files")} value={p.contextFiles().length} loading={!p.context.data()} />
            <Cells.Cell
              icon="link"
              label={p.text("References")}
              value={p.context.data()?.references.length ?? 0}
              loading={!p.context.data()}
            />
          </Cells>
          <Section
            title={p.text("Recent chats")}
            count={p.chatTotal()}
            actions={[
              // The section already names the Project: the action is the short deed.
              { label: p.text("Search chats"), icon: "search", onClick: () => void p.searchChats() },
            ]}
            // Further chats are the way to the rest of the section, at its end.
            more={
              p.chats.hasMore() ? { label: p.text("Load more chats"), icon: "chevron-down", onClick: () => void p.loadMore() } : undefined
            }
          >
            <Show when={p.chats.error()}>{(error) => <Failed text={error().message} onRetry={() => void p.chats.refresh()} />}</Show>
            <Show
              when={p.chatItems().length > 0}
              fallback={
                <Show when={!p.chats.error() && !p.chats.loading()}>
                  <Empty icon="messages" text={p.text("No Project chats yet.")} />
                </Show>
              }
            >
              <List label={p.text("Recent chats")}>
                <For each={p.chatItems()}>
                  {(chat: AiConversation) => (
                    <Row
                      icon="message-circle"
                      lines={[chat.title]}
                      // k2b-ui gap: #4413: a one-line row draws its end over its time, so the time follows the title.
                      meta={<Format.RelativeTime value={chat.updatedAt} />}
                      href={assistantConversationHref("/app/assistant", chat.id)}
                      onNavigate={(nav) => p.openConversation(chat.id, nav)}
                      // The chat's settings, a quiet symbol at the row's end as in v1; the row itself opens the chat.
                      end={
                        <ButtonV2
                          variant="ghost"
                          icon="settings"
                          label={p.copy().editNamed({ name: chat.title })}
                          onClick={() => p.editChat(chat)}
                        />
                      }
                    />
                  )}
                </For>
              </List>
            </Show>
          </Section>
          {/* k2b-ui gap: #4334: a pane has no foot for a composer; it follows the chats until the design study places it. */}
          <Canvas label={p.text("Project")}>
            <div class="assistant-project-composer-v2">{p.props.composer}</div>
          </Canvas>
        </Pane>
        <Pane side label={p.text("Project context")} width={{ min: 300, default: 352 }}>
          {/* k2b-ui gap: #4409: the context's sections (rows with menus, drop to add files) have no v2 parts yet; v1's
              sections draw themselves here, the same as in the chat's p.context column. */}
          <Canvas label={p.text("Project context")}>
            <div ref={p.setContextPanel} class="assistant-project-context-v2">
              <Show when={p.props.project.permission !== "read"}>
                <FileDropTarget
                  for={p.contextPanel()}
                  label={p.text("Drop to add to the Project")}
                  onDrop={(files) => void p.uploadFiles(files)}
                />
              </Show>
              {p.contextSections()}
            </div>
          </Canvas>
        </Pane>
      </Pane.Split>
      {p.lightboxView()}
    </>
  );
}
