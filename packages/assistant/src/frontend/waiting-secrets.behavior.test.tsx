import { afterEach, expect, test } from "bun:test";
import type { AiOpenQuestion } from "@k2b/cloud/ai";
import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// A secret Gustav asks for counts in "Waiting for you": the page lists it beside that count, and the jump lands in the
// card's field only in the window that holds the request.

const first = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { default: AssistantApprovalsView } = await import("./AssistantApprovalsView");
const { createWaitingQuestionFocus } = await import("./AssistantWaitingStrip");
first.cleanup();

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

const secret: AiOpenQuestion = {
  id: "secret-1",
  kind: "secret",
  conversationId: "chat01",
  conversationTitle: "Sendungen prüfen",
  anchor: "tool-secret",
  short: "Secret eintragen: Paketdienst-API",
  app: { name: "Gustav", icon: "ti ti-key" },
  createdAt: "2026-11-19T18:41:00.000Z",
};

test("the waiting page lists open secret requests, so its count never stands beside an empty page", () => {
  const dom = createDomTestHarness();
  const jumps: AiOpenQuestion[] = [];
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AssistantApprovalsView
          initial={{ items: [], nextCursor: null, count: 0, elsewhere: 0 }}
          initialAutomations={[]}
          questions={() => [secret]}
          onJump={(question) => jumps.push(question)}
          timeZone="Europe/Berlin"
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  restore.push(() => {
    dispose();
    dom.cleanup();
  });
  const section = dom.root.querySelector('[aria-labelledby="assistant-waiting-secrets"]');
  expect(section?.querySelector("h2")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Secrets 1");
  expect(section?.querySelector(".assistant-waiting-page__row-title")?.textContent).toBe("Secret eintragen: Paketdienst-API");
  expect(section?.querySelector(".assistant-waiting-page__row-sub")?.textContent).toBe("in Sendungen prüfen");
  expect(dom.root.querySelector(".k2b-placeholder")).toBeNull();
  section?.querySelector<HTMLButtonElement>(".assistant-waiting-page__open")?.click();
  expect(jumps).toEqual([secret]);
});

/** A timeline with the secret card; `held` draws it as another window's request. */
const timeline = (held: boolean) => {
  const dom = createDomTestHarness();
  const viewport = document.createElement("div");
  const content = document.createElement("div");
  content.innerHTML = `<section class="k2b-chat-decision" data-chat-anchor="tool-secret">
    <p class="k2b-chat-decision__sentence" tabindex="-1">Paketdienst-API eintragen?</p>
    <div class="k2b-chat-decision__entry"><div class="k2b-chat-decision__field"><input type="password" ${held ? "disabled" : ""}></div>
    <button class="k2b-button" data-variant="ai" ${held ? "disabled" : ""}>Sicher speichern</button></div>
  </section>`;
  viewport.append(content);
  dom.root.append(viewport);
  const focus = createRoot((dispose) => {
    restore.push(() => {
      dispose();
      dom.cleanup();
    });
    return createWaitingQuestionFocus({
      onlyHere: () => null,
      viewport: () => viewport,
      content: () => content,
      scrollToAnchor: () => true,
      gone: () => {
        throw new Error("The card is there");
      },
    });
  });
  return { content, focus };
};

test("the chip's jump lands in the field of the window that holds the request", async () => {
  const { content, focus } = timeline(false);
  await focus.focus("tool-secret");
  expect(document.activeElement).toBe(content.querySelector("input"));
});

test("in another window the jump lands on the card's question, never in its locked field", async () => {
  const { content, focus } = timeline(true);
  await focus.focus("tool-secret");
  expect(document.activeElement).toBe(content.querySelector(".k2b-chat-decision__sentence"));
});
