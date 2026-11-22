import { afterEach, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AssistantChatContextGroup, AssistantChatContextSnapshot } from "../chat-context";
import { emptySidebarSnapshot } from "./AssistantChatSidebar.fixture";

const bootstrap = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { AssistantChatContextBox } = await import("./AssistantChatContextBox");
bootstrap.cleanup();

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

const noop = () => undefined;
const alarms: AssistantChatContextGroup = {
  key: "wakeups",
  label: "Wecker",
  count: 1,
  unfold: true,
  rows: [{ key: "wakeup:w1", icon: "ti ti-alarm", title: "Lena Vogt wegen der Messe Köln anrufen", word: "21:17", wakeup: "w1" }],
};
// A chat without project, Skills, memories, results, or sources: before the alarm rings its only content is the alarm.
const beforeRing = emptySidebarSnapshot({ groups: [alarms] });
const afterRing = emptySidebarSnapshot({ groups: [] });

const mount = (initial: AssistantChatContextSnapshot) => {
  const dom = createDomTestHarness();
  cleanup.push(dom.cleanup);
  const [snapshot, setSnapshot] = createSignal<AssistantChatContextSnapshot | null>(initial);
  cleanup.push(
    render(
      () => (
        <LocaleProvider locale="de">
          <AssistantChatContextBox
            variant="island"
            state={{ snapshot, projectContext: () => null, error: () => undefined, refresh: async () => undefined }}
            actions={{ onOpen: noop, onJump: noop, onOpenAll: noop, onOpenSources: noop, onOpenContext: noop }}
            frozen={() => false}
          />
        </LocaleProvider>
      ),
      dom.root,
    ),
  );
  const box = () => ({
    empty: dom.root.querySelector(".assistant-context-box__empty")?.textContent ?? null,
    text: dom.root.querySelector(".assistant-context-box")?.textContent ?? "",
  });
  return { box, setSnapshot };
};

test("when the chat's only alarm rings, the box keeps its lines instead of falling back to the empty sentence", () => {
  const view = mount(beforeRing);
  expect(view.box().empty).toBeNull();
  expect(view.box().text).toContain("Lena Vogt wegen der Messe Köln anrufen");

  view.setSnapshot(afterRing);
  expect(view.box().empty).toBeNull();
  expect(view.box().text).not.toContain("Lena Vogt wegen der Messe Köln anrufen");
  expect(view.box().text).toContain("Secrets & Freigaben");
});

test("a reload shows what the chat holds now, and another chat starts from its own content", () => {
  expect(mount(afterRing).box().empty).not.toBeNull();

  const view = mount(beforeRing);
  view.setSnapshot(emptySidebarSnapshot({ chatId: "Other01" }));
  expect(view.box().empty).not.toBeNull();
});
