import { LocaleProvider } from "@k2b/ui";
import { For } from "solid-js";
import { renderToString } from "solid-js/web";
import { AiReaderTimeZoneProvider } from "./chat/action-sentences";
import { AiChatActionsProvider } from "./chat/presentation";
import { createAiToolDisclosureState } from "./chat/tool-disclosure";
import { layoutAiTurn } from "./chat/turn-layout";
import { AiTurnView } from "./chat/turn-view";
import type { AiMap, AiMapToolResult } from "./map-contracts";
import type { AiTurnBlock } from "./protocol";
export const renderMapFixture = (map: AiMap, followups: AiMapToolResult[], locale: string) =>
  renderToString(() => {
    const block = (result: AiMapToolResult, id: string): AiTurnBlock => ({
      kind: "tool",
      id,
      callId: id,
      name: "map",
      status: map.pending ? "running" : "completed",
      args: {},
      result,
    });
    const text = (id: string, followup = false): AiTurnBlock => ({
      kind: "text",
      id,
      text: followup
        ? "Ich habe dieselbe Karte ergänzt. Deine bisherigen Antworten bleiben erhalten."
        : "Hier sind die verifizierten Orte. Die Namen und die Karte sind fiktive Testdaten.",
    });
    const turns = [
      [block({ map, anchor: true }, "original"), text("answer")],
      ...followups.map((result, i) => [block(result, `followup-${i + 1}`), text(`followup-text-${i + 1}`, true)]),
    ];
    return (
      <LocaleProvider locale={locale}>
        <AiReaderTimeZoneProvider value="Europe/Berlin">
          <AiChatActionsProvider actions={{}}>
            <For each={turns}>
              {(blocks) => (
                <AiTurnView
                  segment={() => ({
                    id: blocks[0]!.id,
                    turnId: blocks[0]!.id,
                    phase: "completed",
                    layout: layoutAiTurn(blocks, { phase: "completed" }),
                    earlier: false,
                    duration: () => null,
                  })}
                  disclosureState={createAiToolDisclosureState()}
                />
              )}
            </For>
          </AiChatActionsProvider>
        </AiReaderTimeZoneProvider>
      </LocaleProvider>
    );
  });
