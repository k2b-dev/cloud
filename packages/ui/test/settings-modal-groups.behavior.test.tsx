import { expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Mail's mailbox settings hid their "General" tab, and with it the mailbox name, behind a `<Show>` inside a group.
test("a settings modal shows a conditional tab inside a group and follows its condition", async () => {
  const dom = createDomTestHarness();
  const { default: SettingsModal } = await import("../src/layout/SettingsModal");
  const [admin, setAdmin] = createSignal(true);
  const dispose = render(
    () => (
      <SettingsModal title="Mailbox settings" activeTab="general">
        <SettingsModal.Group title="Mailbox">
          <Show when={admin()}>
            <SettingsModal.Tab id="general" title="General">
              Mailbox name
            </SettingsModal.Tab>
          </Show>
          <SettingsModal.Tab id="organization" title="Organization">
            Views and tags
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </SettingsModal>
    ),
    dom.root,
  );
  const tabs = () => Array.from(dom.root.querySelectorAll('[role="tab"]'), (tab) => tab.textContent);
  const panel = () => dom.root.querySelector('[role="tabpanel"]')?.textContent;
  try {
    expect(tabs()).toEqual(["General", "Organization"]);
    expect(panel()).toContain("Mailbox name");

    setAdmin(false);
    expect(tabs()).toEqual(["Organization"]);
    expect(panel()).toContain("Views and tags");

    setAdmin(true);
    expect(tabs()).toEqual(["General", "Organization"]);
    expect(panel()).toContain("Mailbox name");
  } finally {
    dispose();
    dom.cleanup();
  }
});
