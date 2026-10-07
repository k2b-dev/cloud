import { IconButton, LocaleProvider } from "@k2b/ui";
import { type Accessor, For } from "solid-js";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { AssistantChatSidebarPanel, type ChatSidebarJump } from "./AssistantChatSidebar";
import { createChatSidebarHost } from "./chat-sidebar-layout";
import { chatSidebarMessages } from "./chat-sidebar-messages";

/**
 * The chat layout as the Assistant island renders it, with a long invented conversation, for browser tests and
 * screenshots. The server render and the browser render use this same component.
 */
export function SidebarHarness(props: {
  snapshot: Accessor<AssistantChatContextSnapshot>;
  initialClosed?: boolean;
  locale?: string;
  onJump?: (target: ChatSidebarJump) => void;
  onSheet?: () => void;
}) {
  const host = createChatSidebarHost({ initialClosed: props.initialClosed === true, onSheet: () => props.onSheet?.() });
  const copy = chatSidebarMessages.resolve([props.locale ?? "de"]).t;
  const turns = Array.from({ length: 12 }, (_, index) => index + 1);
  return (
    <LocaleProvider locale={props.locale ?? "de"}>
      <div class="assistant-chat-pane" style={{ display: "flex", "flex-direction": "column", height: "100vh" }}>
        <div
          ref={host.layoutRef}
          class="assistant-chat-layout"
          data-context={host.closed() ? "closed" : "auto"}
          data-drawer={host.drawerOpen() ? "open" : undefined}
        >
          <section class="assistant-chat-messages" style={{ "min-height": "0", display: "flex" }}>
            <div class="k2b-chat-timeline__viewport" style={{ flex: "1", "overflow-y": "auto" }}>
              <div class="harness-timeline" style={{ "max-width": "48rem", margin: "0 auto", padding: "1rem" }}>
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
            <div style={{ "max-width": "48rem", margin: "0 auto", height: "5rem", border: "1px solid #ccc", "border-radius": "1rem" }}>
              Nachricht an den Assistenten …
            </div>
          </div>
          <IconButton
            ref={host.toggleRef}
            class="assistant-context-toggle"
            size="sm"
            variant="ghost"
            label={copy.show}
            aria-expanded="false"
            aria-controls="assistant-chat-context"
            onClick={host.open}
          >
            <i class="ti ti-layout-sidebar-right-expand" aria-hidden="true" />
          </IconButton>
          <AssistantChatSidebarPanel
            id="assistant-chat-context"
            state={{ snapshot: props.snapshot, projectContext: () => null, error: () => undefined, refresh: async () => undefined }}
            actions={{
              onOpenFile: () => undefined,
              onOpenApp: () => undefined,
              onJump: (target) => props.onJump?.(target),
              onOpenSecrets: () => undefined,
            }}
            onClose={host.close}
            headingRef={host.headingRef}
          />
        </div>
      </div>
    </LocaleProvider>
  );
}
