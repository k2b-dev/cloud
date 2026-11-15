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
  // v12 05: the notice has its sign, says what stays, and continuing is a real button, not a bare text link.
  expect(html).toContain("ti-alert-triangle");
  expect(html).toMatch(/<button[^>]*data-variant="secondary"[^>]*>[\s\S]*?Weiterschreiben/);
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

test("an automatic review start keeps an early model failure visible without offering another automatic continuation", () => {
  const start: AiStoredMessage = {
    ...truncatedAnswer,
    id: "review-start",
    seq: 1,
    message: { role: "user", content: ["Gustav startet von selbst, einmal."] },
    stopReason: null,
    usage: null,
    meta: {
      codeReviewStart: { codeId: "c_review", versionId: "11111111-1111-4111-8111-111111111111" },
      turnError: { code: "model_unavailable" },
    },
  };
  const html = renderHistory([start]);
  expect(html).toContain("Gustav startet von selbst");
  expect(html).toContain("Der KI-Dienst hat nicht geantwortet.");
  expect(html).not.toContain("Weiterschreiben");
  const truncated = renderHistory([{ ...start, meta: { codeReviewStart: start.meta!.codeReviewStart } }, truncatedAnswer]);
  expect(truncated).toContain("Die Antwort wurde abgeschnitten");
  expect(truncated).not.toContain("Weiterschreiben");
});

test("a turn the person stopped shows only the quiet stopped line, never the abort notice; Cloud's own end keeps it", () => {
  const stopped = renderHistory([
    {
      ...truncatedAnswer,
      message: { role: "assistant", content: [{ type: "text", text: "Teil" }], stopReason: "aborted" },
      stopReason: "aborted",
      loopDoneReason: "aborted",
      usage: null,
    },
  ]);
  expect(stopped).not.toContain("Die Antwort wurde abgebrochen.");
  expect(stopped).not.toContain("Weiterschreiben");
  // Cloud's own end of an answer keeps its notice: here the output limit, with continuing as a button.
  expect(renderHistory([truncatedAnswer])).toContain("Weiterschreiben");
});

test("an automatic budget stop survives reload and offers only explicit continuation", () => {
  const html = renderHistory([
    {
      ...truncatedAnswer,
      stopReason: "stop",
      message: { role: "assistant", content: [] },
      meta: { automationTurnStop: { reason: "model_calls" } },
    },
  ]);
  expect(html).toContain("Die Arbeit pausiert, weil die Grenze für diesen Lauf erreicht ist.");
  expect(html).toContain("Was bis hier steht, bleibt erhalten.");
  expect(html).toContain("Weiterschreiben");
  expect(html).not.toContain("code_authoring");
});
