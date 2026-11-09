import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { type Accessor, For } from "solid-js";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { AssistantChatSidebarPanel, type ChatSidebarActions, type ChatSidebarJump } from "./AssistantChatSidebar";
import { CHAT_DETAILS_ID, CHAT_MAIN_MIN_WIDTH, createChatSidebarHost } from "./chat-sidebar-layout";

/**
 * The chat workspace as the Assistant island composes it, with invented chats and a long invented conversation, for
 * browser tests and screenshots. The server render and the browser render use this same component.
 */
export function SidebarHarness(props: {
  snapshot: Accessor<AssistantChatContextSnapshot>;
  initialClosed?: boolean;
  locale?: string;
  onJump?: (target: ChatSidebarJump) => void;
  onSecrets?: () => void;
  /** Reloads the snapshot, as after a deletion; nothing changes without it. */
  refresh?: () => Promise<void>;
}) {
  const host = createChatSidebarHost({ initialClosed: props.initialClosed === true });
  const turns = Array.from({ length: 12 }, (_, index) => index + 1);
  const actions: ChatSidebarActions = {
    onOpenFile: () => undefined,
    onOpenApp: () => undefined,
    onJump: (target) => props.onJump?.(target),
    onOpenSecrets: () => props.onSecrets?.(),
  };
  return (
    <LocaleProvider locale={props.locale ?? "de"}>
      <AppWorkspace mobileSurface="flush" class="flex-1 min-h-0">
        <AppWorkspace.Sidebar label="Assistent">
          <AppWorkspace.SidebarDesktop>
            <AppWorkspace.SidebarItem icon="ti ti-message-plus">Neuer Chat</AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarSection title="Chats">
              <AppWorkspace.SidebarItem href="#q3" active>
                Quartalszahlen auswerten
              </AppWorkspace.SidebarItem>
              <AppWorkspace.SidebarItem href="#reise">Reisekosten März</AppWorkspace.SidebarItem>
              <AppWorkspace.SidebarItem href="#angebot">Angebot Werkstatt Nord</AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false} minWidth={CHAT_MAIN_MIN_WIDTH}>
            <AppWorkspace.MainPane id="chat" label="Chat" scroll={false} class="assistant-chat-pane flex min-h-0 flex-col">
              <div class="assistant-chat-layout">
                <section class="assistant-chat-messages" style={{ "min-height": "0", display: "flex" }}>
                  <div class="k2b-chat-timeline__viewport" style={{ flex: "1", "overflow-y": "auto" }}>
                    <div
                      class="harness-timeline k2b-chat-timeline__content"
                      style={{ "max-width": "48rem", margin: "0 auto", padding: "0 1rem" }}
                    >
                      <For each={turns}>
                        {(turn) => (
                          <article data-chat-anchor={String(turn * 3)} style={{ "margin-block": "1.5rem" }}>
                            <p style={{ "text-align": "end" }}>Frage {turn}: Kannst du die Quartalszahlen auswerten?</p>
                            <p>
                              Antwort {turn}. Die Auswertung zeigt, wie sich der Umsatz je Region entwickelt hat. Die Zahlen stammen aus den
                              hochgeladenen Tabellen und wurden mit der Kundenliste verknüpft.
                            </p>
                            <p style={{ height: "18rem" }}>Zwischenschritte der Runde {turn}.</p>
                            <div data-call-id={turn === 9 ? "call-/Umsatzbericht Q1-Q3.pdf" : `call-${turn}`}>Übergabe {turn}</div>
                          </article>
                        )}
                      </For>
                    </div>
                  </div>
                </section>
                <div class="assistant-chat-composer" style={{ padding: "1rem" }}>
                  <div
                    style={{
                      "max-width": "48rem",
                      margin: "0 auto",
                      height: "5rem",
                      border: "1px solid var(--k2b-border)",
                      "border-radius": "1rem",
                      padding: "0.75rem 1rem",
                      color: "var(--k2b-text-muted)",
                    }}
                  >
                    Nachricht an den Assistenten …
                  </div>
                </div>
              </div>
            </AppWorkspace.MainPane>
          </AppWorkspace.Main>
          <AppWorkspace.Detail
            id={CHAT_DETAILS_ID}
            phone="page"
            openOnChoice={false}
            open={!host.closed()}
            onOpen={host.open}
            onClose={host.close}
          >
            <AssistantChatSidebarPanel
              detailId={CHAT_DETAILS_ID}
              state={{
                snapshot: props.snapshot,
                projectContext: () => null,
                error: () => undefined,
                refresh: async () => props.refresh?.(),
              }}
              actions={actions}
              chatTitle="Quartalszahlen auswerten"
              onClose={host.close}
            />
          </AppWorkspace.Detail>
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}
