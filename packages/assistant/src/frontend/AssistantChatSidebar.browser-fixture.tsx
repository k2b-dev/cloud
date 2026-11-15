import { LocaleProvider } from "@k2b/ui";
import { type Accessor, For, Show } from "solid-js";
import type { AssistantChatContextSnapshot } from "../chat-context";
import { AssistantChatContextPlaces, type ContextBoxActions } from "./AssistantChatContextBox";
import { AssistantChatSidebarTab, type ChatSidebarJump } from "./AssistantChatSidebar";

/**
 * The chat layout as the Assistant island renders it, with a long invented conversation, for browser tests and
 * screenshots. The server render and the browser render use this same component. `view="box"` draws the box "In this
 * chat" beside the chat; `view="tab"` draws the chat's whole list as the tab "In this chat" shows it.
 */
export function SidebarHarness(props: {
  snapshot: Accessor<AssistantChatContextSnapshot>;
  /** The box before its first snapshot: loading, or failed with this error. */
  pending?: "loading" | "error";
  view?: "box" | "tab";
  /** Tabs are open beside the chat: the box gives way to its button. */
  tabs?: boolean;
  locale?: string;
  onJump?: (target: ChatSidebarJump) => void;
  onOpenFile?: (file: { path: string; title: string }) => void;
  box?: Partial<ContextBoxActions>;
  onSheet?: () => void;
  onOpenSecrets?: () => void;
  /** Reloads the snapshot, as after a deletion; nothing changes without it. */
  refresh?: () => Promise<void>;
}) {
  const turns = Array.from({ length: 12 }, (_, index) => index + 1);
  const state = {
    snapshot: () => (props.pending ? null : props.snapshot()),
    projectContext: () => null,
    error: () => (props.pending === "error" ? new Error("offline") : undefined),
    refresh: async () => props.refresh?.(),
  };
  const boxActions: ContextBoxActions = {
    onOpen: (target) => {
      if (target.kind === "file") props.onOpenFile?.({ path: target.path, title: target.title });
      else if (target.kind === "jump") props.onJump?.(target.target);
      props.box?.onOpen?.(target);
    },
    onJump: (target) => props.onJump?.(target),
    onOpenAll: () => props.box?.onOpenAll?.(),
    onOpenSources: () => props.box?.onOpenSources?.(),
    onOpenContext: () => props.box?.onOpenContext?.(),
  };
  return (
    <LocaleProvider locale={props.locale ?? "de"}>
      <Show
        when={props.view !== "tab"}
        fallback={
          <div id="assistant-chat-context" style={{ height: "100vh", width: "28rem", "margin-inline-start": "auto" }}>
            <AssistantChatSidebarTab
              state={state}
              actions={{
                onOpenFile: (file) => props.onOpenFile?.(file),
                onJump: (target) => props.onJump?.(target),
                onOpenSecrets: () => props.onOpenSecrets?.(),
              }}
            />
          </div>
        }
      >
        <div class="assistant-chat-pane" style={{ display: "flex", "flex-direction": "column", height: "100vh" }}>
          <div class="assistant-chat-layout" data-tabs={props.tabs ? "open" : undefined}>
            <section class="assistant-chat-messages" style={{ "min-height": "0", display: "flex" }}>
              <div class="k2b-chat-timeline__viewport" style={{ flex: "1", "overflow-y": "auto" }}>
                <div class="harness-timeline k2b-chat-timeline__content">
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
            <AssistantChatContextPlaces
              chatId={props.snapshot().chatId}
              state={state}
              actions={boxActions}
              title="Quartalszahlen auswerten"
              onSheet={() => props.onSheet?.()}
            />
          </div>
        </div>
      </Show>
    </LocaleProvider>
  );
}
