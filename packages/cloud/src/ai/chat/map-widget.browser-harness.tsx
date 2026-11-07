import { LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import type { AiMap, AiMapCommand, AiMapToolResult } from "../map-contracts";
import type { AiTurnBlock } from "../protocol";
import { AiReaderTimeZoneProvider } from "./action-sentences";
import { AiChatActionsProvider } from "./presentation";
import { createAiToolDisclosureState } from "./tool-disclosure";
import { layoutAiTurn } from "./turn-layout";
import { AiTurnView } from "./turn-view";

const snapshot: { map: AiMap; followups: AiMapToolResult[] } = JSON.parse(document.getElementById("snapshot")!.textContent!);
const initial = snapshot.map;
const block = (map: unknown, anchor: boolean, id = "original"): AiTurnBlock => ({
  kind: "tool",
  id,
  callId: id,
  name: "map",
  status: initial.pending ? "running" : "completed",
  args: {},
  result: { map, anchor },
});
const text = (id: string, followup = false): AiTurnBlock => ({
  kind: "text",
  id,
  text: followup
    ? "Ich habe dieselbe Karte ergänzt. Deine bisherigen Antworten bleiben erhalten."
    : "Hier sind die verifizierten Orte. Die Namen und die Karte sind fiktive Testdaten.",
});
const [turns, setTurns] = createSignal<AiTurnBlock[][]>([
  [block(initial, true), text("answer")],
  ...snapshot.followups.map((result, i) => [block(result.map, false, `followup-${i + 1}`), text(`followup-text-${i + 1}`, true)]),
]);
const mount = document.getElementById("fixture-mount")!;
Object.assign(window, {
  mapFollowup: async (command: AiMapCommand) => {
    const response = await fetch(`/fixtures/${initial.conversationId}/followup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!response.ok) throw new Error("FIXTURE_FOLLOWUP_FAILED");
    const result: AiMapToolResult = await response.json();
    setTurns([...turns(), [block(result.map, false, `followup-${turns().length}`), text(`followup-text-${turns().length}`, true)]]);
  },
});
mount.replaceChildren();
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <AiReaderTimeZoneProvider value="Europe/Berlin">
        <AiChatActionsProvider actions={{}}>
          <For each={turns()}>
            {(blocks) => {
              const segment = createMemo(() => ({
                id: blocks[0]!.id,
                turnId: blocks[0]!.id,
                phase: "completed" as const,
                layout: layoutAiTurn(blocks, { phase: "completed" }),
                earlier: false,
                duration: () => null,
              }));
              return <AiTurnView segment={segment} disclosureState={createAiToolDisclosureState()} />;
            }}
          </For>
        </AiChatActionsProvider>
      </AiReaderTimeZoneProvider>
    </LocaleProvider>
  ),
  mount,
);
