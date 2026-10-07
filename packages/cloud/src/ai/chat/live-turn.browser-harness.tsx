import { Chat } from "@k2b/ui";
import { createMemo } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { emptyProjection, reduceProjection, visibleMessages } from "../client/projection";
import type { AiTurnBlock, AiWireEvent } from "../protocol";
import { AiChatActionsProvider, createAiChatTimeline } from "./presentation";

/**
 * The live chat timeline for a browser test, folded from wire events like the
 * controller does. `window.emit(event)` applies one event, and
 * `window.steer(text)` appends a pending steer as the controller does.
 */
const [state, setState] = createStore(emptyProjection());
Object.assign(window, {
  emit: (event: AiWireEvent) => setState(reconcile(reduceProjection(state, event), { key: "id", merge: true })),
  steer: (text: string) =>
    setState("activeTurn", "blocks", (blocks): AiTurnBlock[] => [
      ...blocks,
      { id: `steer-request-${blocks.length}`, kind: "steer_message", steerId: String(blocks.length), text, status: "pending" },
    ]),
});

const root = document.createElement("main");
root.style.cssText = "display: flex; flex-direction: column; height: 100dvh; max-width: 48rem; margin: 0 auto;";
document.body.append(root);
render(
  () => (
    <AiChatActionsProvider actions={{}}>
      {(() => {
        const items = createAiChatTimeline({ messages: createMemo(() => visibleMessages(state)), activeTurn: () => state.activeTurn });
        return <Chat.Timeline items={items()} />;
      })()}
    </AiChatActionsProvider>
  ),
  root,
);
