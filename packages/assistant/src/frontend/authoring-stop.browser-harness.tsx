import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import AssistantAuthoringStop from "./AssistantAuthoringStop";
import { createStoppedAuthoringFixture } from "./authoring-stop.test-fixture";

// The persisted stop in a Gustav chat column. `window.settleSend(ok)` answers the pending continue: a failure keeps the
// card, a success appends the new request below it as the normal send path would.
const locale = new URLSearchParams(location.search).get("lang") === "de" ? "de" : "en";
const { messages } = await createStoppedAuthoringFixture(locale);
const [history, setHistory] = createSignal(messages);
const continued: string[] = [];
let settle: ((ok: boolean) => void) | undefined;
const root = document.createElement("main");
root.style.cssText = "max-width: 48rem; margin: 0 auto; padding: 24px 16px";
(document.querySelector(".app-accent-scope") ?? document.body).append(root);
// Measured with the typeface and icons loaded, as Cloud preloads them, so a rectangle change is the card's own and not a
// font swap.
await Promise.all(["400 14px 'IBM Plex Sans'", "600 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)));
render(
  () => (
    <LocaleProvider locale={locale}>
      <AiChatActionsProvider
        actions={{
          renderCodeAuthoringStop: (state, continuable) => <AssistantAuthoringStop state={state} continuable={continuable} />,
          onContinueTurn: (message) => {
            continued.push(message);
            return new Promise<void>((resolve, reject) => {
              settle = (ok) => {
                if (!ok) return reject(new Error("fixture offline"));
                setHistory([
                  ...messages,
                  { ...messages[0]!, id: "next", seq: 3, loopId: "next", message: { role: "user", content: [message] } },
                ]);
                resolve();
              };
            });
          },
        }}
      >
        <Chat>
          <Chat.Timeline items={createAiChatTimeline({ messages: history, activeTurn: () => null })()} />
        </Chat>
      </AiChatActionsProvider>
    </LocaleProvider>
  ),
  root,
);
// The card's box in its first frame, before anything could settle it.
const firstRect = await new Promise<DOMRect | null>((resolve) =>
  requestAnimationFrame(() => resolve(document.querySelector(".assistant-authoring-stop")?.getBoundingClientRect() ?? null)),
);
Object.assign(window, { continued, firstRect: firstRect?.toJSON() ?? null, settleSend: (ok: boolean) => settle?.(ok) });
