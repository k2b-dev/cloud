import { expect, test } from "bun:test";
import "../../../../ui/test/solid-ssr-preload";
import { Chat, LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { chatDoneFact, chatDoneMessage } from "../../../../../scripts/fixtures/chat-done";
import { buildAiMessageTimeline } from "../timeline";

const { AiChatActionsProvider, createAiChatTimeline } = await import("./presentation");

const render = (status: "completed" | "failed" | "aborted", locale = "de", available = true) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: {},
          get children() {
            const fact = chatDoneFact(status);
            if (!available && fact.meta?.chatDone) {
              delete fact.meta.chatDone.name;
              delete fact.meta.chatDone.href;
            }
            const items = createAiChatTimeline({
              messages: () => [chatDoneMessage(1, "Ich suche die Hotels im anderen Chat."), fact],
              activeTurn: () => null,
              timeZone: "UTC",
            });
            return createComponent(Chat.Timeline, {
              get items() {
                return items();
              },
            });
          },
        });
      },
    }),
  );

test.each([
  ["completed", "ist fertig"],
  ["failed", "ist fehlgeschlagen"],
  ["aborted", "wurde abgebrochen"],
] as const)("%s is a shared activity, with its exact answer link and time, never a new assistant answer", (status, words) => {
  const html = render(status);
  expect(html).toMatch(/class="[^"]*k2b-chat-activity[^"]*ai-chat-done-line/);
  expect(html).toContain(words);
  expect(html).toContain("Hotels in Lyon");
  expect(html).toContain("Ergebnis ansehen");
  expect(html).toContain('href="/app/assistant?conversation=Target&amp;message=2"');
  expect(html).toContain("10:19");
  expect(html.match(/<article/g)).toHaveLength(1);
});
test("English and unavailable destinations stay truthful", () => {
  expect(render("completed", "en")).toContain("View result");
  const html = render("failed", "de", false);
  expect(html).toContain("Weitergegebener Auftrag");
  expect(html).not.toContain("Hotels in Lyon");
  expect(html).not.toContain("Ergebnis ansehen");
});
test("a fact arriving during an answer does not split or rename that answer", () => {
  const first = chatDoneMessage(1, "Die Anreise");
  const last = chatDoneMessage(4, "mit dem Zug.");
  const before = buildAiMessageTimeline([first, last]);
  const after = buildAiMessageTimeline([first, chatDoneFact(), last]);
  expect(after.map((item) => item.type)).toEqual(["assistant", "chat-done"]);
  expect(after[0]).toEqual(before[0]);
});
