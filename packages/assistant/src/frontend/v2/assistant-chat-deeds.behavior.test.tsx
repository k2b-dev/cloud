import { expect, mock, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

// The list of every chat fails to open: the person learns it from a toast that offers to try again, never silence.
let opens = 0;
mock.module("../rare-dialogs", () => ({
  openAssistantAllChatsDialog: () => {
    opens++;
    return Promise.reject(new Error("unavailable"));
  },
  openAssistantConversationEditor: () => Promise.resolve(undefined),
  openAssistantPrefsModal: () => Promise.resolve(undefined),
}));
// The modules read browser globals as they load.
const bootstrap = createDomTestHarness();
const { createAssistantChatDeeds } = await import("./assistant-chat-deeds");
const { createAssistantLiveHub } = await import("../assistant-live");
const { LocaleProvider } = await import("@k2b/ui");
bootstrap.cleanup();

test("a list of every chat that cannot open says so in a toast with Try again", async () => {
  const dom = createDomTestHarness();
  try {
    let openAll: (() => void) | undefined;
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          {(() => {
            const deeds = createAssistantChatDeeds({
              basePath: "/app/assistant",
              locale: () => "de",
              live: createAssistantLiveHub(),
              projects: () => [],
              conversations: () => [],
              activeConversationId: () => null,
              archiveBlocker: () => null,
              queuedMessageCount: () => undefined,
              openConversation: async () => true,
              onUpdated: () => {},
              onArchived: () => {},
            });
            openAll = deeds.openAll;
            return null;
          })()}
        </LocaleProvider>
      ),
      dom.root,
    );
    openAll?.();
    for (let attempt = 0; attempt < 50 && !dom.document.body.textContent?.includes("ließ sich nicht öffnen"); attempt++)
      await Bun.sleep(10);
    expect(dom.document.body.textContent).toContain("Die Liste aller Chats ließ sich nicht öffnen.");
    expect(opens).toBe(1);
    const retry = [...dom.document.querySelectorAll("button")].find((button) => button.textContent?.includes("Erneut versuchen"));
    expect(retry).toBeDefined();
    dispose();
  } finally {
    dom.cleanup();
  }
});
