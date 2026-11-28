import { runContextAwareCommand } from "@k2b/cloud/browser/commands";
import { contextCommandsWithShortcuts } from "@k2b/cloud/browser/testing";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import SpaceScreen from "./SpaceScreen";
import { type SpaceFixtureState, spaceFixtureStates, spaceScreenProps } from "./space-screen.fixture";

/** A Space on v2 for a browser test, as the page renders it for the address; `data-state` picks the fixture state. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const states: SpaceFixtureState[] = spaceFixtureStates;
const state = states.find((entry) => entry === document.documentElement.dataset.state) ?? "usual";

// The Cloud shell runs a page's single-key commands (J, K, N): one key, one published command, never while a field or
// a dialog has the keys. cloud gap: @k2b/cloud/browser/testing does not export the shell's dispatcher
// (`attachCommandShortcuts`), so the harness stands in for it with the same rule for keys without modifiers.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]")
    )
      return;
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    const key = event.key.toLowerCase();
    const matches = contextCommandsWithShortcuts().filter((command) => command.shortcut === (event.shiftKey ? `shift+${key}` : key));
    if (matches.length !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    void runContextAwareCommand(matches[0]!);
  },
  true,
);

render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <SpaceScreen {...spaceScreenProps(`${location.pathname}${location.search}`, state)} />
    </LocaleProvider>
  ),
  host,
);
document.body.dataset.ready = "true";
