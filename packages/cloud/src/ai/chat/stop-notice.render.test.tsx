import { expect, test } from "bun:test";
import "../../../../ui/test/solid-ssr-preload";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiActiveTurn } from "../client/projection";
import type { AiStoredMessage } from "../types";
import { truncatedAnswer } from "./stop-notice.test-fixture";

const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");

const renderHistory = (messages: AiStoredMessage[], activeTurn: AiActiveTurn | null = null) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: { onContinueTurn: () => {} },
          get children() {
            const timeline = createAiChatTimeline({ messages: () => messages, activeTurn: () => activeTurn });
            return createComponent(Chat.Timeline, {
              get items() {
                return timeline();
              },
            });
          },
        });
      },
    }),
  );

test("reload SSR shows a completed max_tokens answer with the reasoning clause and continue action", () => {
  // The canonical persisted fields, as delivered by the history API; no live events or client state exist here.
  const messages = structuredClone([truncatedAnswer]);
  const html = renderHistory(messages);
  expect(html).toContain("Die Antwort wurde abgeschnitten");
  expect(html).toContain("Das Nachdenken hat den größten Teil davon verbraucht.");
  expect(html).toContain("Weiterschreiben");
  expect(html).not.toContain("max_tokens");
  expect(messages[0]?.loopDoneReason).toBe("stop");
});

test("legacy null-loop messages cannot continue while a turn runs or after a newer message", () => {
  const legacy = { ...truncatedAnswer, loopId: null };
  const active: AiActiveTurn = { turnId: "new", seq: 1, attempt: 1, status: "running", blocks: [], modelId: null };
  expect(renderHistory([legacy], active)).not.toContain("Weiterschreiben");
  const next: AiStoredMessage = { ...legacy, id: "next", seq: 3, message: { role: "user", content: ["Next question"] } };
  expect(renderHistory([legacy, next])).not.toContain("Weiterschreiben");
  expect(renderHistory([legacy])).toContain("Weiterschreiben");
});

test("an answer with no visible text still renders the truncation notice", () => {
  const html = renderHistory([{ ...truncatedAnswer, message: { role: "assistant", content: [], stopReason: "max_tokens" } }]);
  expect(html).toContain("Die Antwort wurde abgeschnitten");
  expect(html).toContain("Das Nachdenken hat den größten Teil davon verbraucht.");
});
