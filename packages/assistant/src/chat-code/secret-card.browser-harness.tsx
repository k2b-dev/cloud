import type { AiOpenQuestion, AiTurnBlock } from "@k2b/cloud/ai";
import { LocaleProvider } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { AssistantWaitingStrip } from "../frontend/AssistantWaitingStrip";
import { SecretRequestEntry } from "./SecretRequestEntry";
import { SECRET_CARD_SCENES, type SecretCardScene, secretCardScene, secretSceneArgs } from "./secret-card.fixture";
import { registerSecretRequest } from "./secret-request-registry";

/** One scene of mockup v4 in the real card, Assistant CSS and fonts; `wartet` scenes show the waiting row instead. */
const [scene, setScene] = createSignal<{ id: string; code: boolean; step: SecretCardScene["step"]; result?: unknown; key: number }>();
let count = 0;
let unregister = () => {};

const show = async (id: string, options: { reload?: boolean } = {}) => {
  unregister();
  setScene(undefined);
  const wait = id === "wartet" || id === "c-wartet";
  const found = SECRET_CARD_SCENES.find((item) => item.id === id);
  if (!found && !wait) throw new Error(`Unknown scene ${id}`);
  const key = ++count;
  if (found && !options.reload) {
    const { controller } = await secretCardScene(found);
    unregister = registerSecretRequest({ conversationId: "chat", turnId: "turn", callId: `call-${key}` }, controller);
  }
  setScene({
    id,
    code: found?.code ?? id === "c-wartet",
    step: options.reload ? (found?.step ?? "interaction") : "interaction",
    result: options.reload ? found?.result : undefined,
    key,
  });
};

const question = (code: boolean): AiOpenQuestion => ({
  id: "secret-1",
  kind: "secret",
  conversationId: "other",
  conversationTitle: code ? "Automation Paketstatus" : "Sendungen prüfen",
  anchor: "tool-secret",
  short: `Secret eintragen: ${code ? "Paketdienst_API" : "Paketdienst-API"}`,
  app: { name: "Gustav", icon: "ti ti-key" },
  createdAt: "2026-11-19T18:41:00.000Z",
});

function Harness() {
  return (
    <LocaleProvider locale="de">
      <main class="secret-harness" style={{ "max-width": "48rem", margin: "0 auto", padding: "24px 16px" }}>
        <Show keyed when={scene()}>
          {(current) => {
            const block = (): Extract<AiTurnBlock, { kind: "tool" }> => ({
              kind: "tool",
              id: `tool-call-${current.key}`,
              callId: `call-${current.key}`,
              name: "code_secret",
              status: current.step === "interaction" ? "awaiting_client" : "completed",
              args: secretSceneArgs(current.code),
              result: current.result,
              at: "2026-11-19T18:42:00.000Z",
            });
            const waiting = current.id.endsWith("wartet");
            return (
              <>
                <p id="before" style={{ margin: "0 0 12px", "line-height": "1.6" }}>
                  {current.code
                    ? "Für die Abfrage braucht sie deinen API-Schlüssel vom Paketdienst. Ich hinterlege ihn an der Automation."
                    : "Dafür frage ich die Paketdienst-API einmal ab. Ich brauche deinen API-Schlüssel."}
                </p>
                <Show
                  when={!waiting}
                  fallback={
                    <div style={{ position: "relative", "margin-top": "320px" }}>
                      <AssistantWaitingStrip
                        view={{ attention: [], entries: [question(current.code)], more: 0, total: 1, onlyHere: null, onlyHereAtEnd: false }}
                        conversationId="chat"
                        quiet={false}
                        onJump={() => {}}
                        onShowMore={() => {}}
                      />
                    </div>
                  }
                >
                  <SecretRequestEntry
                    turnId="turn"
                    block={block}
                    state={() => current.step}
                    conversationId={() => "chat"}
                    timeZone="Europe/Berlin"
                  />
                </Show>
                {/* What follows the card in the timeline: it must never move while the card changes its state. */}
                <div id="following" style={{ height: "1px" }} />
              </>
            );
          }}
        </Show>
      </main>
    </LocaleProvider>
  );
}

declare global {
  interface Window {
    showSecretScene: typeof show;
  }
}
window.showSecretScene = show;
render(() => <Harness />, document.body.querySelector("#root")!);
