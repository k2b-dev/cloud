import { AiChatActionsProvider, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { Chat, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AssistantAuthoringStop from "./AssistantAuthoringStop";
import { createStoppedAuthoringFixture } from "./authoring-stop.test-fixture";

const locale = new URLSearchParams(location.search).get("lang") === "de" ? "de" : "en";
const { messages } = await createStoppedAuthoringFixture(locale);
const continued: string[] = [];
let finish: (() => void) | undefined;
Object.assign(window, { continued, finishSend: () => finish?.() });
const root = document.createElement("main");
root.style.cssText = "max-width: 48rem; margin: 0 auto; padding: 24px 16px";
document.body.append(root);
const mount = () =>
  render(
    () => (
      <LocaleProvider locale={locale}>
        <AiChatActionsProvider
          actions={{
            renderCodeAuthoringStop: (state, continuable) => <AssistantAuthoringStop state={state} continuable={continuable} />,
            onContinueTurn: (message) => {
              continued.push(message);
              return new Promise<void>((_resolve, reject) => {
                finish = () => reject(new Error("fixture offline"));
              });
            },
          }}
        >
          <Chat>
            <Chat.Timeline items={createAiChatTimeline({ messages: () => messages, activeTurn: () => null })()} />
          </Chat>
        </AiChatActionsProvider>
      </LocaleProvider>
    ),
    root,
  );
let dispose = mount();
Object.assign(window, {
  resetFixture: () => {
    dispose();
    continued.length = 0;
    dispose = mount();
  },
});
