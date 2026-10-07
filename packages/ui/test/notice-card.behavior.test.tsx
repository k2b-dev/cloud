import { expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

test("a notice adds its body only while its children render something", async () => {
  const dom = createDomTestHarness();
  const { NoticeCard } = await import("../src/surfaces/NoticeCard");
  const [offered, setOffered] = createSignal(false);
  const dispose = render(
    () => (
      <NoticeCard tone="danger" title="The answer was interrupted." detail="The model service did not answer.">
        <Show when={offered()}>
          <button type="button">Continue</button>
        </Show>
      </NoticeCard>
    ),
    dom.root,
  );
  try {
    // No empty body, so the detail's gap to a body never adds space below the notice.
    expect(dom.root.querySelector(".k2b-notice-card__body")).toBeNull();
    setOffered(true);
    expect(dom.root.querySelector(".k2b-notice-card__body button")?.textContent).toBe("Continue");
    setOffered(false);
    expect(dom.root.querySelector(".k2b-notice-card__body")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
