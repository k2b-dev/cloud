import { Chat, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { type GalleryScene, galleryScenes } from "./chat-gallery.fixtures";
import { AiChatActionsProvider, createAiChatTimeline } from "./presentation";

/**
 * One state of the Gustav chat for a browser test or a screenshot: `?scene=` picks the invented chat, `?lang=` the
 * locale. The chat column and composer sit like in Assistant. `window.opened` lists the references the chat opened,
 * `window.retried` the retried messages, `window.feedback` the ratings.
 */
const params = new URLSearchParams(location.search);
const scene = (params.get("scene") ?? "antwort") as GalleryScene;
const locale = params.get("lang") ?? "de";
const opened: unknown[] = [];
const retried: unknown[] = [];
const feedback: unknown[] = [];
Object.assign(window, { opened, retried, feedback });

const root = document.createElement("main");
root.className = "assistant-chat-layout";
root.style.cssText = "height: 100dvh;";
root.dataset.context = "closed";
document.body.append(root);
const [draft, setDraft] = createSignal("");
render(
  () => (
    <LocaleProvider locale={locale}>
      <AiChatActionsProvider
        actions={{
          onOpenReference: (title, ref) => void opened.push({ title, ref }),
          onRetryMessage: async (entry, input) => void retried.push({ id: entry.id, ...input }),
          onMessageFeedback: async (entry, value) => void feedback.push({ id: entry.id, value }),
          onForkMessage: async () => {},
        }}
      >
        {(() => {
          const messages = galleryScenes[scene]();
          const items = createAiChatTimeline({ messages: () => messages, activeTurn: () => null });
          return (
            <>
              <div class="assistant-chat-messages">
                <Chat.Timeline items={items()} />
              </div>
              {/* As in AssistantWorkspace: the composer column under the timeline's. */}
              <div class="assistant-chat-composer" style="padding: 0.5rem var(--ui-space-section) var(--ui-space-section)">
                <div style="max-width: 48rem; margin-inline: auto; display: flex; flex-direction: column; gap: 0.5rem">
                  <Chat.Composer value={draft()} onValueChange={setDraft} onSubmit={() => true} placeholder="Gustav etwas fragen" />
                </div>
              </div>
            </>
          );
        })()}
      </AiChatActionsProvider>
    </LocaleProvider>
  ),
  root,
);
document.body.dataset.ready = "";
